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
  writeWitnessBundle,
  type CaptureOptions,
} from './witness-capture.js';
import { validateManifest } from './witness-contract.js';

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
  node --import tsx src/deployment/witness-main.ts [options]

Options:
  --label <string>               Human-readable label for this witness run
  --runtime-health-url <url>     Override runtime health endpoint (default: http://127.0.0.1:3001/health)
  --runtime-dashboard-url <url>  Override runtime dashboard endpoint (default: http://127.0.0.1:3001/dashboard.json)
  --notifier-health-url <url>    Override notifier health endpoint (default: http://127.0.0.1:8788/health)
  --bridge-health-url <url>      Override bridge health endpoint (default: http://127.0.0.1:8787/health)
  --db-path <path>               Override SQLite database path (default: ./data/trader.db)
  --http-timeout-ms <ms>         HTTP request timeout in ms (default: 10000)
  --help, -h                     Show this help

Environment variable overrides (same names with WITNESS_ prefix):
  WITNESS_RUNTIME_HEALTH_URL
  WITNESS_RUNTIME_DASHBOARD_URL
  WITNESS_NOTIFIER_HEALTH_URL
  WITNESS_BRIDGE_HEALTH_URL
  WITNESS_DB_PATH
  WITNESS_HTTP_TIMEOUT_MS

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
  };

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

main().catch(err => {
  console.error(`[witness] UNHANDLED ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
