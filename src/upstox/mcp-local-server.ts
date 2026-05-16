import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { getUpstoxTokenHealth, readUpstoxTokenRecord } from './token-store.js';
import { UpstoxRestClient } from './upstox-rest-client.js';

const DEFAULT_PORT = 8787;
const DEFAULT_STATUS_PATH = './tmp/upstox/mcp-local/status.json';

interface ToolInvocationSummary {
  tool: string;
  at: string;
  durationMs: number;
  itemCount: number | null;
  error: string | null;
}

interface BridgeStatus {
  startedAt: string;
  uptimeMs: number;
  port: number;
  statusPath: string;
  token: ReturnType<typeof getUpstoxTokenHealth>;
  rest: ReturnType<UpstoxRestClient['getStatus']>;
  recentCalls: ToolInvocationSummary[];
  lastSuccess: ToolInvocationSummary | null;
  lastFailure: ToolInvocationSummary | null;
}

export interface UpstoxMcpLocalServerOptions {
  port?: number;
  statusPath?: string;
  restClient?: UpstoxRestClient;
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
}

export interface UpstoxMcpLocalServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): BridgeStatus;
  readonly port: number;
}

const quoteInputSchema = z.object({
  instrumentKeys: z.array(z.string()).optional(),
  instrument_keys: z.array(z.string()).optional(),
  instrument_key: z.string().optional(),
}).passthrough();

const instrumentsInputSchema = z.object({
  exchanges: z.array(z.string()).optional(),
  segments: z.array(z.string()).optional(),
  instrumentTypes: z.array(z.string()).optional(),
  maxRecords: z.number().int().positive().max(15000).optional(),
}).passthrough();

const historicalCandlesInputSchema = z.object({
  instrumentKey: z.string().min(1, 'instrumentKey is required'),
  interval: z.enum(['1minute', '5minute', '15minute', '30minute', '60minute', '1day', '1week', '1month']),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate must be YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate must be YYYY-MM-DD'),
}).passthrough();

export function createUpstoxMcpLocalServer(options: UpstoxMcpLocalServerOptions = {}): UpstoxMcpLocalServer {
  const port = options.port ?? Number(process.env.TRADER_UPSTOX_MCP_LOCAL_PORT ?? DEFAULT_PORT);
  const host = process.env.TRADER_UPSTOX_MCP_LOCAL_HOST?.trim() || '127.0.0.1';
  let boundPort = port;
  const statusPath = options.statusPath ?? (process.env.TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH?.trim() || DEFAULT_STATUS_PATH);
  const restClient = options.restClient ?? new UpstoxRestClient({
    timeoutMs: Number(process.env.TRADER_UPSTOX_MCP_TIMEOUT_MS ?? process.env.TRADER_BROKER_MCP_TIMEOUT_MS ?? 30_000),
  });
  const logger = options.logger ?? console;

  const startedAt = Date.now();
  const recentCalls: ToolInvocationSummary[] = [];
  let lastSuccess: ToolInvocationSummary | null = null;
  let lastFailure: ToolInvocationSummary | null = null;

  function createMcpProtocol(): McpServer {
    const mcpServer = new McpServer({
      name: 'trader-upstox-mcp-local',
      version: '0.1.0',
    });

    mcpServer.registerTool(
      'get-profile',
      {
        description: 'Verify notifier-backed Upstox auth and return profile metadata.',
      },
      async () => {
        const started = Date.now();
        try {
          const profile = await restClient.fetchProfile();
          const count = profile.data && typeof profile.data === 'object' ? Object.keys(profile.data).length : null;
          recordCall('get-profile', Date.now() - started, count, null);
          return {
            content: [{ type: 'text', text: JSON.stringify(profile) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCall('get-profile', Date.now() - started, null, message);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }
      },
    );

    mcpServer.registerTool(
      'get-instruments-bod',
      {
        description: 'Return Upstox BOD instrument records filtered for runtime use.',
        inputSchema: instrumentsInputSchema,
      },
      async (args) => {
        const started = Date.now();
        try {
          const records = await restClient.fetchInstruments(args);
          recordCall('get-instruments-bod', Date.now() - started, records.length, null);
          return {
            content: [{ type: 'text', text: JSON.stringify(records) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCall('get-instruments-bod', Date.now() - started, null, message);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }
      },
    );

    mcpServer.registerTool(
      'get-full-market-quote',
      {
        description: 'Return full market quotes for one or more Upstox instrument keys.',
        inputSchema: quoteInputSchema,
      },
      async (args) => {
        const started = Date.now();
        try {
          const instrumentKeys = collectInstrumentKeys(args);
          if (instrumentKeys.length === 0) {
            throw new Error('No instrument keys provided');
          }
          const quotes = await restClient.fetchFullMarketQuotes(instrumentKeys);
          recordCall('get-full-market-quote', Date.now() - started, Object.keys(quotes.data ?? {}).length, null);
          return {
            content: [{ type: 'text', text: JSON.stringify(quotes) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCall('get-full-market-quote', Date.now() - started, null, message);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }
      },
    );

    mcpServer.registerTool(
      'get-historical-candles',
      {
        description: 'Return 1-minute OHLCV candles for any Upstox instrument key over a given date range.',
        inputSchema: historicalCandlesInputSchema,
      },
      async (args) => {
        const started = Date.now();
        try {
          const { instrumentKey, interval, fromDate, toDate } = args;
          const candles = await restClient.fetchHistoricalCandles(instrumentKey, interval, fromDate, toDate);
          const count = candles.data?.candles?.length ?? 0;
          recordCall('get-historical-candles', Date.now() - started, count, null);
          return {
            content: [{ type: 'text', text: JSON.stringify(candles) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCall('get-historical-candles', Date.now() - started, null, message);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }
      },
    );

    return mcpServer;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          status: 'ok',
          bridge: getStatus(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, getStatus());
      }

      if (url.pathname === '/mcp') {
        const protocol = createMcpProtocol();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        transport.onerror = error => {
          logger.error(`[upstox-mcp-local] transport error: ${error.message}`);
        };
        await protocol.connect(transport);
        res.on('close', () => {
          void Promise.allSettled([transport.close(), protocol.close()]).catch(() => undefined);
        });
        await transport.handleRequest(req, res);
        return;
      }

      json(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[upstox-mcp-local] request failed: ${message}`);
      json(res, 500, { error: 'internal_error', message });
    }
  });

  function recordCall(tool: string, durationMs: number, itemCount: number | null, error: string | null): ToolInvocationSummary {
    const summary: ToolInvocationSummary = {
      tool,
      at: new Date().toISOString(),
      durationMs,
      itemCount,
      error,
    };

    recentCalls.unshift(summary);
    if (recentCalls.length > 20) recentCalls.length = 20;

    if (error) {
      lastFailure = summary;
      logger.warn(`[upstox-mcp-local] ${tool} failed in ${durationMs}ms: ${error}`);
    } else {
      lastSuccess = summary;
      logger.log(`[upstox-mcp-local] ${tool} succeeded in ${durationMs}ms${itemCount !== null ? ` (${itemCount} items)` : ''}`);
    }

    persistStatus();
    return summary;
  }

  function getStatus(): BridgeStatus {
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
      port: boundPort,
      statusPath: path.resolve(statusPath),
      token: getUpstoxTokenHealth(),
      rest: restClient.getStatus(),
      recentCalls: [...recentCalls],
      lastSuccess,
      lastFailure,
    };
  }

  function persistStatus(): void {
    const target = path.resolve(statusPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(getStatus(), null, 2));
  }

  return {
    get port() {
      return boundPort;
    },
    async start(): Promise<void> {
      persistStatus();
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          if (address && typeof address === 'object') {
            boundPort = address.port;
          }
          logger.log(`[upstox-mcp-local] listening on http://${host}:${boundPort}`);
          logger.log(`[upstox-mcp-local] health: http://${host}:${boundPort}/health`);
          logger.log(`[upstox-mcp-local] mcp: http://${host}:${boundPort}/mcp`);
          logger.log(`[upstox-mcp-local] status file: ${path.resolve(statusPath)}`);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => error ? reject(error) : resolve());
      });
    },
    getStatus,
  };
}

function collectInstrumentKeys(args: z.infer<typeof quoteInputSchema>): string[] {
  const values = new Set<string>();

  for (const key of args.instrumentKeys ?? []) {
    if (key.trim()) values.add(key.trim());
  }
  for (const key of args.instrument_keys ?? []) {
    if (key.trim()) values.add(key.trim());
  }
  if (args.instrument_key) {
    for (const key of args.instrument_key.split(',')) {
      if (key.trim()) values.add(key.trim());
    }
  }

  return [...values];
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body, null, 2));
}
