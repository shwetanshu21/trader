import { createUpstoxMcpLocalServer } from './mcp-local-server.js';

async function main(): Promise<void> {
  const server = createUpstoxMcpLocalServer();
  await server.start();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[upstox-mcp-local] received ${signal}; shutting down`);
      void server.stop().finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[upstox-mcp-local] fatal: ${message}`);
  process.exitCode = 1;
});
