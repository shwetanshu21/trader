import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProposalStatus,
  type ProposalEngineConfig,
} from '../src/types/runtime.js';
import { ProposalEngine, type EngineContext } from '../src/proposals/proposal-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ProposalEngineConfig>): ProposalEngineConfig {
  return {
    providerMode: overrides?.providerMode ?? 'custom',
    providerUrl: overrides?.providerUrl ?? 'https://api.example.com/proposals',
    timeoutMs: overrides?.timeoutMs ?? 5000,
    maxProposalsPerTick: overrides?.maxProposalsPerTick ?? 5,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<EngineContext>): EngineContext {
  return {
    instruments: overrides?.instruments ?? [],
    marketPhase: overrides?.marketPhase ?? 'regular',
    maxProposals: overrides?.maxProposals ?? 5,
    ...overrides,
  };
}

/** Helper to create a mock Response that returns JSON. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Helper to create a mock Response that returns text (non-JSON). */
function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProposalEngine', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('normalization', () => {
    it('normalizes a valid provider response into proposals', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
              tag: 'test',
            },
            {
              exchange: 'NFO',
              tradingsymbol: 'BANKNIFTY24DEC50000CE',
              side: 'sell',
              product: 'NRML',
              quantity: 50,
              price: 150.50,
              triggerPrice: null,
              orderType: 'LIMIT',
            },
          ],
          reasoning: 'Test reasoning',
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).toBeNull();
      expect(result.proposals).toHaveLength(2);
      expect(result.reasoning).toBe('Test reasoning');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // First proposal (NSE MARKET)
      expect(result.proposals[0].attempt.exchange).toBe('NSE');
      expect(result.proposals[0].attempt.tradingsymbol).toBe('RELIANCE');
      expect(result.proposals[0].attempt.side).toBe('buy');
      expect(result.proposals[0].attempt.product).toBe('MIS');
      expect(result.proposals[0].attempt.quantity).toBe(1);
      expect(result.proposals[0].attempt.price).toBeNull();
      expect(result.proposals[0].attempt.orderType).toBe('MARKET');
      expect(result.proposals[0].attempt.proposalStatus).toBe(ProposalStatus.Pending);

      // Second proposal (NFO LIMIT)
      expect(result.proposals[1].attempt.exchange).toBe('NFO');
      expect(result.proposals[1].attempt.tradingsymbol).toBe('BANKNIFTY24DEC50000CE');
      expect(result.proposals[1].attempt.side).toBe('sell');
      expect(result.proposals[1].attempt.product).toBe('NRML');
      expect(result.proposals[1].attempt.quantity).toBe(50);
      expect(result.proposals[1].attempt.price).toBe(150.50);
      expect(result.proposals[1].attempt.orderType).toBe('LIMIT');
    });

    it('rejects proposals with unsupported exchange', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'BSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('normalization');
      expect(result.proposals).toHaveLength(0);
    });

    it('rejects proposals with invalid side', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'hold',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('rejects proposals with missing product', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'BO',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('rejects proposals with invalid order type', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'BO',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('rejects proposals with zero quantity', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 0,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('rejects LIMIT order with null price', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'LIMIT',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('filters out invalid proposals, keeping valid ones', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'RELIANCE',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
            {
              exchange: 'BSE', // Unsupported — will be filtered
              tradingsymbol: 'SOME',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      // The NSE proposal should survive filtering
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].attempt.exchange).toBe('NSE');
      expect(result.proposals[0].attempt.tradingsymbol).toBe('RELIANCE');
      expect(result.refusal).toBeNull();
    });
  });

  describe('HTTP error handling', () => {
    it('returns refusal on 5xx', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('500');
      expect(result.proposals).toHaveLength(0);
    });

    it('returns refusal on 4xx', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('401');
      expect(result.proposals).toHaveLength(0);
    });

    it('returns refusal on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('ECONNREFUSED');
      expect(result.proposals).toHaveLength(0);
    });
  });

  describe('malformed response handling', () => {
    it('returns refusal on non-JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(textResponse('not json'));

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.proposals).toHaveLength(0);
    });

    it('returns refusal on missing proposals array', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ foo: 'bar' }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('proposals');
      expect(result.proposals).toHaveLength(0);
    });

    it('returns refusal on empty proposals array', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ proposals: [] }),
      );

      const engine = new ProposalEngine(makeConfig());
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('empty');
      expect(result.proposals).toHaveLength(0);
    });
  });

  describe('timeout handling', () => {
    it('aborts and returns refusal on timeout', async () => {
      // Create a fetch that never resolves until aborted
      let abortHandler: (() => void) | null = null;
      const abortPromise = new Promise<never>((_, reject) => {
        abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, options?: RequestInit) => {
          // Simulate abort signal
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              if (abortHandler) abortHandler();
            });
          }
          return abortPromise;
        },
      );

      const engine = new ProposalEngine(makeConfig({ timeoutMs: 10 }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('timed out');
      expect(result.proposals).toHaveLength(0);
    }, 5000);
  });

  describe('openai-compatible mode', () => {
    it('parses a valid OpenAI-compatible response into proposals', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  proposals: [
                    {
                      exchange: 'NSE',
                      tradingsymbol: 'RELIANCE',
                      side: 'buy',
                      product: 'MIS',
                      quantity: 1,
                      price: null,
                      triggerPrice: null,
                      orderType: 'MARKET',
                    },
                  ],
                  reasoning: 'OpenAI-compatible reasoning',
                }),
              },
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'kimi-k2.6-precision',
      }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).toBeNull();
      expect(result.reasoning).toBe('OpenAI-compatible reasoning');
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].attempt.exchange).toBe('NSE');
      expect(result.proposals[0].attempt.tradingsymbol).toBe('RELIANCE');
    });

    it('sends OpenAI-compatible chat completions request shape', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, options?: RequestInit) => {
          capturedBody = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>;
          return Promise.resolve(jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    proposals: [
                      {
                        exchange: 'NSE',
                        tradingsymbol: 'RELIANCE',
                        side: 'buy',
                        product: 'MIS',
                        quantity: 1,
                        price: null,
                        triggerPrice: null,
                        orderType: 'MARKET',
                      },
                    ],
                  }),
                },
              },
            ],
          }));
        },
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'kimi-k2.6-precision',
      }));
      await engine.generateProposals(makeContext());

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!['model']).toBe('kimi-k2.6-precision');
      expect(capturedBody!['messages']).toBeInstanceOf(Array);
      expect(capturedBody!['response_format']).toEqual({ type: 'json_object' });
    });

    it('parses reasoning-only fenced JSON OpenAI-compatible responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                reasoning_content: '```json\n' + JSON.stringify({
                  proposals: [
                    {
                      exchange: 'NSE',
                      tradingsymbol: 'INFY',
                      side: 'buy',
                      product: 'MIS',
                      quantity: 1,
                      price: null,
                      triggerPrice: null,
                      orderType: 'MARKET',
                    },
                  ],
                }) + '\n```',
              },
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'glm-4.7',
      }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).toBeNull();
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].attempt.tradingsymbol).toBe('INFY');
    });

    it('falls back to the next configured model when the primary model fails', async () => {
      const capturedModels: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
        const body = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>;
        const model = String(body.model ?? '');
        capturedModels.push(model);
        if (model === 'glm-5.1') {
          return Promise.resolve(jsonResponse({ error: { message: 'slow model failed' } }, 500));
        }
        return Promise.resolve(jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  proposals: [
                    {
                      exchange: 'NSE',
                      tradingsymbol: 'TCS',
                      side: 'buy',
                      product: 'MIS',
                      quantity: 1,
                      price: null,
                      triggerPrice: null,
                      orderType: 'MARKET',
                    },
                  ],
                }),
              },
            },
          ],
        }));
      });

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'glm-5.1',
        fallbackProviderModel: 'glm-4.7',
      }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).toBeNull();
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].attempt.tradingsymbol).toBe('TCS');
      expect(capturedModels).toEqual(['glm-5.1', 'glm-4.7']);
    });

    it('returns refusal when OpenAI-compatible response is missing assistant content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'kimi-k2.6-precision',
      }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('missing assistant content');
      expect(result.proposals).toHaveLength(0);
    });

    it('returns refusal when OpenAI-compatible assistant content is not valid JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'not json' } }] }),
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'kimi-k2.6-precision',
      }));
      const result = await engine.generateProposals(makeContext());

      expect(result.refusal).not.toBeNull();
      expect(result.refusal!.reasonMessage).toContain('assistant content is not valid JSON');
      expect(result.proposals).toHaveLength(0);
    });
  });

  describe('config passthrough', () => {
    it('custom mode still posts the canonical payload directly', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, options?: RequestInit) => {
          capturedBody = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>;
          return Promise.resolve(jsonResponse({ proposals: [] }));
        },
      );

      const engine = new ProposalEngine(makeConfig({ providerMode: 'custom' }));
      await engine.generateProposals(makeContext());

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!['version']).toBe('1.0');
      expect(capturedBody!['marketPhase']).toBe('regular');
      expect(capturedBody!['segment']).toBe('NSE');
      expect(capturedBody!['maxProposals']).toBe(5);
      expect(capturedBody!['instruments']).toBeInstanceOf(Array);
      expect(typeof capturedBody!['instructions']).toBe('string');
    });

    it('sends Authorization header when apiKey is configured', async () => {
      let capturedHeaders: Record<string, string> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, options?: RequestInit) => {
          capturedHeaders = options?.headers as Record<string, string>;
          return Promise.resolve(jsonResponse({ proposals: [] }));
        },
      );

      const engine = new ProposalEngine(makeConfig({ apiKey: 'sk-test-123' }));
      await engine.generateProposals(makeContext());

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!['Authorization']).toBe('Bearer sk-test-123');
    });
  });
});
