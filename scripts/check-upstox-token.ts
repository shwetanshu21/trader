import fs from 'node:fs';
import path from 'node:path';

function loadDotenv(filePath: string): Record<string, string> {
  const text = fs.readFileSync(filePath, 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .filter(line => !line.startsWith('#'))
      .map(line => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

async function main(): Promise<void> {
  const env = loadDotenv(path.resolve('.env'));
  const tokenPath = env.TRADER_UPSTOX_TOKEN_PATH ?? './tmp/upstox/notifier/latest-token.json';
  const absolute = path.resolve(tokenPath);

  if (!fs.existsSync(absolute)) {
    console.log(JSON.stringify({ exists: false, tokenPath: absolute }, null, 2));
    return;
  }

  const payload = JSON.parse(fs.readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  console.log(JSON.stringify({
    exists: true,
    tokenPath: absolute,
    clientId: payload.client_id ?? null,
    userId: payload.user_id ?? null,
    expiresAt: payload.expires_at ?? null,
    issuedAt: payload.issued_at ?? null,
    messageType: payload.message_type ?? null,
    accessToken: mask(typeof payload.access_token === 'string' ? payload.access_token : undefined),
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
