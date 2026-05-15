#!/usr/bin/env bash
# ── Replay Runner (shell entrypoint) ──
# Runs a historical replay session against the local database using the
# fixture-backed historical data provider.
#
# Usage:
#   bash scripts/replay-run.sh [--days 7] [--cadence 5] [--max 5]
#
# Options:
#   --days D     Number of days to replay (default: 7)
#   --cadence M  Tick cadence in minutes (default: 5)
#   --max N      Maximum candidates per tick (default: 5)
#
# Prerequisites:
#   - Node.js 18+
#   - Project dependencies installed (npm ci)
#   - DB schema up to date (tests create schema automatically)
#
# This script uses the fixture provider — no real market data required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Parse arguments ────────────────────────────────────────────────────
DAYS=7
CADENCE=5
MAX=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)    DAYS="$2"; shift 2 ;;
    --cadence) CADENCE="$2"; shift 2 ;;
    --max)     MAX="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "─────────────────────────────────────────────────────────────"
echo "  Replay Runner"
echo "─────────────────────────────────────────────────────────────"
echo "  Days:      $DAYS"
echo "  Cadence:   ${CADENCE}min"
echo "  Max cand:  $MAX"
echo "─────────────────────────────────────────────────────────────"

# ── Run the replay runner via tsx ─────────────────────────────────────
# We use a small inline script that composes the replay runner with the
# fixture provider and the project's database.

npx tsx -e "
import Database from 'better-sqlite3';
import { DatabaseManager } from './src/persistence/sqlite';
import { ReplayClock } from './src/replay/replay-clock';
import { FixtureHistoricalDataProvider } from './src/replay/historical-data-provider';
import { runReplay } from './src/replay/replay-runner';
import { INDIA_NSE_EQ_MARKET } from './src/market/india-profile';
import type { BoundedCandidate } from './src/types/runtime';

async function main() {
  // ── 1. Open a temporary in-memory DB with schema ──────────────────
  const dbManager = new DatabaseManager(':memory:');

  // ── 2. Create fixture candidates ─────────────────────────────────
  const now = Date.now();
  const candidates: BoundedCandidate[] = [
    {
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      instrumentToken: 738561,
      side: 'buy',
      lastPrice: 2450.50,
      bid: 2450.00,
      ask: 2451.00,
      volume: 1250000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
    {
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      instrumentToken: 2953217,
      side: 'buy',
      lastPrice: 3890.00,
      bid: 3889.50,
      ask: 3890.50,
      volume: 850000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
    {
      exchange: 'NSE',
      tradingsymbol: 'HDFCBANK',
      instrumentToken: 341249,
      side: 'buy',
      lastPrice: 1680.25,
      bid: 1680.00,
      ask: 1680.50,
      volume: 2100000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
  ];

  const rangeStart = now - ${DAYS} * 86_400_000;
  const rangeEnd = now;

  const dataProvider = new FixtureHistoricalDataProvider({
    candidates,
    rangeStart,
    rangeEnd,
    priceDrift: 0.001,
  });

  // ── 3. Run the replay ──────────────────────────────────────────────
  const result = await runReplay({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
    maxCandidates: ${MAX},
    cadenceMinutes: ${CADENCE},
    label: 'cli-replay-run',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
  });

  // ── 4. Print results ───────────────────────────────────────────────
  const s = result.session;
  console.log('\\n─────────────────────────────────────────────────────────────');
  console.log('  Replay Complete');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Session ID:    ' + s.id);
  console.log('  Label:         ' + s.label);
  console.log('  Status:        ' + s.status);
  console.log('  Total ticks:   ' + s.totalTicks);
  console.log('  Completed:     ' + s.completedTicks);
  console.log('  Persisted runs:' + result.engineResult.strategyRunsPersisted);
  console.log('  Duration:      ' + result.engineResult.durationMs + 'ms');
  console.log('  Total setup:   ' + result.totalDurationMs + 'ms');
  console.log('  Fidelity:      ' + (s.effectiveFidelity ?? 'N/A'));
  console.log('  Error:         ' + (s.errorMessage ?? 'none'));
  console.log('─────────────────────────────────────────────────────────────');

  dbManager.close();
}

main().catch(err => {
  console.error('Replay runner failed:', err);
  process.exit(1);
});
"
