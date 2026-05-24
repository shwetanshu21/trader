import { requestUpstoxToken } from '../src/upstox/token-request-service.js';

async function main(): Promise<void> {
  const result = await requestUpstoxToken(process.env);

  console.log(JSON.stringify({
    step: 'requesting_upstox_token',
    clientId: result.clientId,
    notifierUrl: result.notifierUrl,
  }, null, 2));

  console.log(JSON.stringify({ status: result.status, body: result.bodyText }, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
