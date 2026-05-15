import { getUpstoxTokenHealth } from '../src/upstox/token-store.js';

async function main(): Promise<void> {
  console.log(JSON.stringify(getUpstoxTokenHealth(), null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
