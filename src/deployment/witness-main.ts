#!/usr/bin/env node
// ── Deployment Witness CLI Entrypoint ──
//
// One-command CAX11 witness capture.
//
// Usage:
//   node --import tsx src/deployment/witness-main.ts
//   node --import tsx src/deployment/witness-main.ts --label "pre-deploy-check"
//   WITNESS_RUNTIME_HEALTH_URL=http://other:3001/health node --import tsx src/deployment/witness-main.ts
//
// Exits 0 on success, non-zero if required evidence is missing or capture fails.

import {
  captureWitness,
  runSteadyStateWitness,
  writeWitnessBundle,
  writeSteadyStateBundle,
  type CaptureOptions,
} from './witness-capture.js';
import { validateManifest, validateSteadyStateManifest } from './witness-contract.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  label?: string;
  runtimeHealthUrl?: string;
  runtimeDashboardUrl?: string;
  notifierHealthUrl?: string;
  bridgeHealthUrl?: string;
  dbPath?: string;
  httpTimeoutMs?: number;
  /** Steady-state witness mode */
  steadyState?: boolean;
  steadyStateDurationSec?: number;
  steadyStateIntervalSec?: number;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--label':
        args.label = argv[++i];
        break;
      case '--runtime-health-url':
        args.runtimeHealthUrl = argv[++i];
        break;
      case '--runtime-dashboard-url':
        args.runtimeDashboardUrl = argv[++i];
        break;
      case '--notifier-health-url':
        args.notifierHealthUrl = argv[++i];
        break;
      case '--bridge-health-url':
        args.bridgeHealthUrl = argv[++i];
        break;
      case '--db-path':
        args.dbPath = argv[++i];
        break;
      case '--http-timeout-ms':
        args.httpTimeoutMs = Number(argv[++i]);
        break;
      case '--steady-state':
        args.steadyState = true;
        break;
      case '--steady-state-duration-sec':
        args.steadyStateDurationSec = Number(argv[++i]);
        break;
      case '--steady-state-interval-sec':
        args.steadyStateIntervalSec = Number(argv[++i]);
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`[witness] WARNING: unknown option ${arg}`);
        }
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
CAX11 Deployment Witness — one-command capture

Usage:
  node --import tsx src/deployment/witness-main.ts [options]                   Point-in-time witness
  node --import tsx src/deployment/witness-main.ts --steady-state [options]   Steady-state witness

Options:
  --label <string>               Human-readable label for this witness run
  --runtime-health-url <url>     Override runtime health endpoint (default: http://127.0.0.1:3001/health)
  --runtime-dashboard-url <url>  Override runtime dashboard endpoint (default: http://127.0.0.1:3001/dashboard.json)
  --notifier-health-url <url>    Override notifier health endpoint (default: http://127.0.0.1:8788/health)
  --bridge-health-url <url>      Override bridge health endpoint (default: http://127.0.0.1:8787/health)
  --db-path <path>               Override SQLite database path (default: ./data/production.db)
  --http-timeout-ms <ms>         HTTP request timeout in ms (default: 10000)

Steady-state options:
  --steady-state                 Run steady-state witness instead of point-in-time capture
  --steady-state-duration-sec <n>  Witness window duration in seconds (default: 120)
  --steady-state-interval-sec <n>  Sampling interval in seconds (default: 30)

Environment variable overrides (same names with WITNESS_ prefix):
  WITNESS_RUNTIME_HEALTH_URL
  WITNESS_RUNTIME_DASHBOARD_URL
  WITNESS_NOTIFIER_HEALTH_URL
  WITNESS_BRIDGE_HEALTH_URL
  WITNESS_DB_PATH
  WITNESS_HTTP_TIMEOUT_MS
  WITNESS_STEADY_STATE_DURATION_SEC
  WITNESS_STEADY_STATE_INTERVAL_SEC

Exit codes:
  0  — All required evidence captured successfully
  1  — One or more required subsystems are unreachable
  2  — Fatal error during capture (network, filesystem, etc.)
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Build options from CLI args and env overrides
  const options: CaptureOptions = {
    label: args.label ?? process.env.WITNESS_LABEL ?? undefined,
    runtimeHealthUrl: args.runtimeHealthUrl ?? process.env.WITNESS_RUNTIME_HEALTH_URL ?? undefined,
    runtimeDashboardUrl: args.runtimeDashboardUrl ?? process.env.WITNESS_RUNTIME_DASHBOARD_URL ?? undefined,
    notifierHealthUrl: args.notifierHealthUrl ?? process.env.WITNESS_NOTIFIER_HEALTH_URL ?? undefined,
    bridgeHealthUrl: args.bridgeHealthUrl ?? process.env.WITNESS_BRIDGE_HEALTH_URL ?? undefined,
    dbPath: args.dbPath ?? process.env.WITNESS_DB_PATH ?? undefined,
    httpTimeoutMs: args.httpTimeoutMs ?? (
      process.env.WITNESS_HTTP_TIMEOUT_MS ? Number(process.env.WITNESS_HTTP_TIMEOUT_MS) : undefined
    ),
    steadyStateDurationSec: args.steadyStateDurationSec ?? (
      process.env.WITNESS_STEADY_STATE_DURATION_SEC ? Number(process.env.WITNESS_STEADY_STATE_DURATION_SEC) : undefined
    ),
    steadyStateIntervalSec: args.steadyStateIntervalSec ?? (
      process.env.WITNESS_STEADY_STATE_INTERVAL_SEC ? Number(process.env.WITNESS_STEADY_STATE_INTERVAL_SEC) : undefined
    ),
  };

  if (args.steadyState) {
    await runSteadyState(options);
  } else {
    await runPointInTime(options);
  }
}

async function runPointInTime(options: CaptureOptions): Promise<void> {
  console.log(`[witness] Starting CAX11 deployment witness capture...`);
  console.log(`[witness] Run ID will be auto-generated from current timestamp`);

  if (options.label) {
    console.log(`[witness] Label: ${options.label}`);
  }

  // Run capture
  let result;
  try {
    result = await captureWitness(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[witness] FATAL: capture failed: ${message}`);
    process.exit(2);
  }

  // Write bundle
  let manifestPath: string;
  let evidencePaths: string[];
  try {
    const written = writeWitnessBundle(result);
    manifestPath = written.manifestPath;
    evidencePaths = written.evidencePaths;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[witness] FATAL: failed to write bundle: ${message}`);
    process.exit(2);
  }

  console.log(`\n[witness] Bundle written to: ${result.bundleDir}`);
  console.log(`[witness]   manifest: ${manifestPath}`);
  for (const ep of evidencePaths) {
    console.log(`[witness]   evidence: ${ep}`);
  }

  // Validate manifest against contract
  const violations = validateManifest(result.manifest);
  if (violations.length > 0) {
    console.warn(`\n[witness] WARNING: manifest has ${violations.length} contract violation(s):`);
    for (const v of violations) {
      console.warn(`  ❌ ${v}`);
    }
  } else {
    console.log(`\n[witness] Manifest contract validation: PASS`);
  }

  // Check required evidence
  const unreachableRequired = result.manifest.subsystems.filter(
    s => s.required && !s.reachable,
  );

  console.log(`\n[witness] Subsystem summary:`);
  for (const sub of result.manifest.subsystems) {
    const status = sub.reachable ? '✅ reachable' : '❌ unreachable';
    const required = sub.required ? '(required)' : '(optional)';
    console.log(`  ${sub.id}: ${status} ${required}`);
  }

  if (unreachableRequired.length > 0) {
    console.error(`\n❌ FAIL: ${unreachableRequired.length} required subsystem(s) unreachable:`);
    for (const s of unreachableRequired) {
      console.error(`  - ${s.id} (${s.label})`);
    }
    process.exit(1);
  }

  console.log(`\n✅ PASS: All required subsystems reachable`);
  console.log(`[witness] Capture complete. Bundle: ${result.bundleDir}`);

  // Also print a compact summary for operators
  console.log(`\n---`);
  console.log(`Witness bundle: ${result.bundleDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Subsystems: ${result.manifest.subsystems.length} total, ${unreachableRequired.length} unreachable required`);
  console.log(`Host: ${result.manifest.hostEvidence.hostname} (${result.manifest.hostEvidence.platform} ${result.manifest.hostEvidence.arch})`);
  console.log(`App verdict: ${result.manifest.appEvidence.verdict}`);
  process.exit(0);
}

async function runSteadyState(options: CaptureOptions): Promise<void> {
  console.log(`[witness] Starting CAX11 steady-state witness capture...`);
  console.log(`[witness] Duration: ${options.steadyStateDurationSec ?? 120}s, Interval: ${options.steadyStateIntervalSec ?? 30}s`);

  if (options.label) {
    console.log(`[witness] Label: ${options.label}`);
  }

  // Run steady-state witness
  let result;
  try {
    result = await runSteadyStateWitness(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[witness] FATAL: steady-state capture failed: ${message}`);
    process.exit(2);
  }

  const m = result.manifest;

  // Write bundle to disk
  let manifestPath: string;
  try {
    const written = writeSteadyStateBundle(result.bundleDir, m);
    manifestPath = written.manifestPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[witness] FATAL: failed to write steady-state bundle: ${message}`);
    process.exit(2);
  }

  console.log(`\n[witness] Steady-state witness complete.`);
  console.log(`[witness] Bundle: ${result.bundleDir}`);
  console.log(`[witness] Manifest: ${manifestPath}`);
  console.log(`[witness] Window: ${m.durationSec}s (${m.resourceSamples.length} samples, ${m.intervalSec}s interval)`);

  // Validate manifest against contract
  const violations = validateSteadyStateManifest(m);
  if (violations.length > 0) {
    console.warn(`\n[witness] WARNING: manifest has ${violations.length} contract violation(s):`);
    for (const v of violations) {
      console.warn(`  ❌ ${v}`);
    }
  } else {
    console.log(`[witness] Manifest contract validation: PASS`);
  }

  // Print verdict
  const verdictIcon = m.verdict.verdict === 'pass' ? '✅' : m.verdict.verdict === 'caveat' ? '⚠️' : '❌';
  console.log(`\n${verdictIcon} Verdict: ${m.verdict.verdict.toUpperCase()}`);
  console.log(`  ${m.verdict.summary}`);
  console.log(`  Reasoning: ${m.verdict.reasoning}`);

  // Print resource summary
  console.log(`\nResource summary:`);
  console.log(`  Memory: ${(m.resourceSummary.memory.avgUsedBytes / 1024 / 1024).toFixed(0)} MB avg (peak ${(m.resourceSummary.memory.peakUsageFraction * 100).toFixed(0)}%)`);
  console.log(`  Load: ${m.resourceSummary.load.avgLoad1m} avg (peak ${m.resourceSummary.load.peakLoad1m})`);
  if (m.resourceSummary.disk.totalGrowthBytes > 0) {
    console.log(`  Disk growth: ${(m.resourceSummary.disk.totalGrowthBytes / 1024 / 1024).toFixed(1)} MB total`);
  }

  // Print subsystem evidence summary
  console.log(`\nSubsystem evidence:`);
  for (const se of m.subsystemEvidence) {
    const icon = se.healthyThroughout ? '✅' : '❌';
    console.log(`  ${icon} ${se.subsystemId}: healthy=${se.healthyThroughout} (${se.probes.length} probes)`);
    if (se.missingEvidenceReason) {
      console.log(`     missing evidence: ${se.missingEvidenceReason}`);
    }
  }

  // Print process evidence
  console.log(`\nProcess evidence:`);
  for (const p of m.processEvidence) {
    const icon = p.running ? '✅' : '❌';
    console.log(`  ${icon} ${p.processName}${p.pid ? ` (PID ${p.pid})` : ''}`);
  }

  // Print growth records
  if (m.growthRecords.length > 0) {
    console.log(`\nGrowth records:`);
    for (const gr of m.growthRecords) {
      const growthMb = (gr.growthBytes / 1024 / 1024).toFixed(2);
      const rateMbHr = (gr.growthBytesPerHour / 1024 / 1024).toFixed(2);
      console.log(`  ${gr.label}: ${growthMb} MB growth (${rateMbHr} MB/hr)`);
    }
  }

  if (m.verdict.concerns.length > 0) {
    console.log(`\n⚠️  Concerns (${m.verdict.concerns.length}):`);
    for (const c of m.verdict.concerns) {
      console.log(`  - ${c}`);
    }
  }

  // Exit with appropriate code
  if (m.verdict.verdict === 'fail') {
    process.exit(1);
  }

  console.log(`\n✅ Steady-state witness complete. Bundle: ${result.bundleDir}`);
  console.log(`Manifest: ${manifestPath}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[witness] UNHANDLED ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
