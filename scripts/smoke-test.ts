// ── S01 Smoke Test ──
// Verifies the scheduler starts, ticks, and stops cleanly.
// Run via: npx tsx --esm scripts/smoke-test.ts

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { Scheduler } from '../src/runtime/scheduler.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

async function main(): Promise<void> {
  const db = new DatabaseManager(':memory:');
  const repo = new RuntimeStateRepository(db.db);
  const lifecycle = new LifecycleManager(repo);
  const health = new HealthService(lifecycle, repo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const telemetry = new Telemetry(repo);

  const scheduler = new Scheduler({
    clock, lifecycle, repo, health, telemetry,
    intervalMs: 30,
  });

  // Start
  const s1 = scheduler.start();
  console.log(`Start status: ${s1.status}`);
  if (s1.status !== 'running') {
    console.error('FAIL: Scheduler did not start (running)');
    process.exit(1);
  }

  // Wait for ticks
  await new Promise(r => setTimeout(r, 120));

  const s2 = scheduler.getState();
  console.log(`Ticks: ${s2.tickCount}`);
  if (s2.tickCount < 2) {
    console.error(`FAIL: Scheduler did not tick enough (got ${s2.tickCount})`);
    process.exit(1);
  }

  // Pause
  const paused = scheduler.pause();
  console.log(`Pause status: ${paused.status}`);
  if (paused.status !== 'paused') {
    console.error('FAIL: Scheduler did not pause');
    process.exit(1);
  }

  // Resume
  const resumed = scheduler.resume();
  console.log(`Resume status: ${resumed.status}`);
  if (resumed.status !== 'running') {
    console.error('FAIL: Scheduler did not resume');
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 60));

  // Stop
  const s3 = scheduler.stop('smoke test done');
  console.log(`Stop status: ${s3.status}`);
  if (s3.status !== 'stopped') {
    console.error('FAIL: Scheduler did not stop');
    process.exit(1);
  }

  // Health check
  const h = health.getHealth();
  console.log(`Health verdict: ${h.verdict}`);
  console.log(`Health lifecycle: ${h.lifecycleState}`);

  if (h.verdict !== 'unhealthy') {
    console.error(`FAIL: Expected unhealthy after stop, got ${h.verdict}`);
    process.exit(1);
  }

  console.log('\nSmoke test: OK');
  db.close();
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
