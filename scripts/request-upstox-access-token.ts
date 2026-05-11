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

async function main(): Promise<void> {
  const env = loadDotenv(path.resolve('.env'));
  const clientId = env.UPSTOX_CLIENT_ID;
  const clientSecret = env.UPSTOX_CLIENT_SECRET;
  const notifierUrl = env.UPSTOX_NOTIFIER_URL;

  if (!clientId || !clientSecret) {
    throw new Error('UPSTOX_CLIENT_ID and UPSTOX_CLIENT_SECRET are required in .env');
  }

  console.log(JSON.stringify({
    step: 'requesting_upstox_token',
    clientId,
    notifierUrl: notifierUrl ?? null,
  }, null, 2));

  const response = await fetch(`https://api.upstox.com/v3/login/auth/token/request/${clientId}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ client_secret: clientSecret }),
  });

  const bodyText = await response.text();
  console.log(JSON.stringify({ status: response.status, body: bodyText }, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
