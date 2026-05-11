import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

interface UpstoxTokenPayload {
  client_id?: string;
  user_id?: string;
  access_token?: string;
  token_type?: string;
  expires_at?: string;
  issued_at?: string;
  message_type?: string;
  [key: string]: unknown;
}

const port = Number(process.env.TRADER_UPSTOX_NOTIFIER_PORT ?? '8788');
const tokenPath = process.env.TRADER_UPSTOX_TOKEN_PATH?.trim() || './tmp/upstox/notifier/latest-token.json';
const startTime = Date.now();
let lastDeliveryMeta: Record<string, unknown> | null = null;

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body, null, 2));
}

function maskedToken(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleNotifier(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: UpstoxTokenPayload;

  try {
    payload = raw ? JSON.parse(raw) as UpstoxTokenPayload : {};
  } catch {
    json(res, 400, { error: 'invalid_json' });
    return;
  }

  if (!payload.access_token || typeof payload.access_token !== 'string') {
    json(res, 400, { error: 'missing_access_token' });
    return;
  }

  const persistedAt = Date.now();
  const record = {
    ...payload,
    persisted_at: persistedAt,
  };

  ensureParent(tokenPath);
  fs.writeFileSync(tokenPath, JSON.stringify(record, null, 2));

  lastDeliveryMeta = {
    receivedAt: new Date(persistedAt).toISOString(),
    clientId: payload.client_id ?? null,
    userId: payload.user_id ?? null,
    tokenType: payload.token_type ?? null,
    expiresAt: payload.expires_at ?? null,
    issuedAt: payload.issued_at ?? null,
    messageType: payload.message_type ?? null,
    accessToken: maskedToken(payload.access_token),
    persistedPath: tokenPath,
  };

  console.log(`[upstox-notifier] token received ${JSON.stringify({
    clientId: payload.client_id ?? null,
    userId: payload.user_id ?? null,
    expiresAt: payload.expires_at ?? null,
    accessToken: maskedToken(payload.access_token),
  })}`);

  json(res, 200, { ok: true, receivedAt: lastDeliveryMeta.receivedAt });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        uptimeMs: Date.now() - startTime,
        notifierPath: '/upstox/notifier',
        tokenPath,
        lastDelivery: lastDeliveryMeta,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/last-delivery') {
      json(res, 200, {
        tokenPath,
        lastDelivery: lastDeliveryMeta,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upstox/notifier') {
      await handleNotifier(req, res);
      return;
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: 'internal_error', message });
  }
});

server.listen(port, () => {
  console.log(`[upstox-notifier] listening on http://localhost:${port}`);
  console.log(`[upstox-notifier] health: http://localhost:${port}/health`);
  console.log(`[upstox-notifier] webhook path: http://localhost:${port}/upstox/notifier`);
  console.log(`[upstox-notifier] token path: ${tokenPath}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[upstox-notifier] received ${signal}; shutting down`);
    server.close(() => process.exit(0));
  });
}
