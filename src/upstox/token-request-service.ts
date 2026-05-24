export interface UpstoxTokenRequestResult {
  ok: boolean;
  status: number;
  bodyText: string;
  clientId: string;
  notifierUrl: string | null;
  requestedAt: string;
}

export class UpstoxTokenRequestError extends Error {
  readonly code: 'MISSING_CONFIG' | 'REQUEST_FAILED';

  constructor(code: UpstoxTokenRequestError['code'], message: string) {
    super(message);
    this.name = 'UpstoxTokenRequestError';
    this.code = code;
  }
}

export async function requestUpstoxToken(
  env: Record<string, string | undefined> = process.env,
): Promise<UpstoxTokenRequestResult> {
  const clientId = env.UPSTOX_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.UPSTOX_CLIENT_SECRET?.trim() ?? '';
  const notifierUrl = env.UPSTOX_NOTIFIER_URL?.trim() || null;

  if (!clientId || !clientSecret) {
    throw new UpstoxTokenRequestError(
      'MISSING_CONFIG',
      'UPSTOX_CLIENT_ID and UPSTOX_CLIENT_SECRET are required to request a fresh Upstox token.',
    );
  }

  const response = await fetch(`https://api.upstox.com/v3/login/auth/token/request/${clientId}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ client_secret: clientSecret }),
  });

  const bodyText = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    bodyText,
    clientId,
    notifierUrl,
    requestedAt: new Date().toISOString(),
  };
}
