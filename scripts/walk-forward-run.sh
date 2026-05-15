#!/usr/bin/env bash
# ── Walk-Forward Runner (shell entrypoint) ──
# Runs a walk-forward evaluation session against the local database using the
# fixture-backed historical data provider.
#
# Usage:
#   bash scripts/walk-forward-run.sh [--days 30] [--window 7] [--step 1]
#                                    [--ratio 0.8] [--trials 3-5-llm]
#
# Options:
#   --days D     Number of days of historical data to use (default: 30)
#   --window W   Window size in days (default: 7)
#   --step S     Step size in days (default: 1)
#   --ratio R    In-sample ratio (default: 0.8)
#   --trials T   Trial configuration preset: 'default', 'grid', or 'llm' (default: default)
#
# Prerequisites:
#   - Node.js 18+
#   - Project dependencies installed (npm ci)
#   - DB schema up to date (tests create schema automatically)
#
# This script uses the fixture provider no real market data required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Parse arguments ────────────────────────────────────────────────────
DAYS=30
WINDOW=7
STEP=1
RATIO=0.8
TRIALS="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)    DAYS="$2"; shift 2 ;;
    --window)  WINDOW="$2"; shift 2 ;;
    --step)    STEP="$2"; shift 2 ;;
    --ratio)   RATIO="$2"; shift 2 ;;
    --trials)  TRIALS="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "─────────────────────────────────────────────────────────────"
echo "  Walk-Forward Runner"
echo "─────────────────────────────────────────────────────────────"
echo "  Days:         $DAYS"
echo "  Window:       ${WINDOW}d"
echo "  Step:         ${STEP}d"
echo "  In-sample:    ${RATIO}"
echo "  Trials preset:$TRIALS"
echo "─────────────────────────────────────────────────────────────"

# ── Run the walk-forward evaluator via tsx ─────────────────────────────

npx tsx -e "
import Database from 'better-sqlite3';
import { DatabaseManager } from './src/persistence/sqlite';
import { WalkForwardEvaluator } from './src/replay/walk-forward-evaluator';
import { FixtureHistoricalDataProvider } from './src/replay/historical-data-provider';
import { INDIA_NSE_EQ_MARKET } from './src/market/india-profile';
import type { BoundedCandidate } from './src/types/runtime';

async function main() {
  // ── 1. Open a temporary in-memory DB with schema ──────────────────
  const dbManager = new DatabaseManager(':memory:');
  const now = Date.now();

  // ── 2. Create fixture candidates ─────────────────────────────────
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

  // ── 3. Create the evaluator ───────────────────────────────────────
  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
  });

  // ── 4. Determine trial configs based on preset ────────────────────
  let trialConfigs: Array<{ label: string; params: Record<string, unknown> }>;

  switch ('${TRIALS}') {
    case 'grid':
      trialConfigs = [
        { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
        { label: 'Config C (7 candidates)', params: { maxCandidates: 7 } },
        { label: 'Config D (10 candidates)', params: { maxCandidates: 10 } },
      ];
      break;
    case 'llm':
      trialConfigs = [
        { label: 'Config A (no LLM)', params: { maxCandidates: 5 } },
        { label: 'Config B (LLM enabled)', params: { maxCandidates: 5, llmEnabled: true } },
      ];
      break;
    default:
      trialConfigs = [
        { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
      ];
      break;
  }

  // ── 5. Run the evaluation ─────────────────────────────────────────
  const windowSizeMs = ${WINDOW} * 86_400_000;
  const stepSizeMs = ${STEP} * 86_400_000;

  console.log('  Range:        ' + new Date(rangeStart).toISOString().slice(0, 10) + ' → ' + new Date(rangeEnd).toISOString().slice(0, 10));
  console.log('  Windows:      ' + Math.floor((${DAYS} - ${WINDOW}) / ${STEP} + 1) + ' (est.)');
  console.log('  Trials:       ' + trialConfigs.length);
  console.log('─────────────────────────────────────────────────────────────');

  const result = await evaluator.evaluate({
    rangeStart,
    rangeEnd,
    windowSizeMs,
    stepSizeMs,
    inSampleRatio: ${RATIO},
    label: 'cli-walk-forward',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    trialConfigs,
  });

  // ── 6. Print results ───────────────────────────────────────────────
  console.log('\\n─────────────────────────────────────────────────────────────');
  console.log('  Walk-Forward Complete');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Run ID:       ' + result.run.id);
  console.log('  Label:        ' + result.run.label);
  console.log('  Status:       ' + result.run.status);
  console.log('  Windows:      ' + result.windows.length);
  console.log('  Trials:       ' + result.trials.length);
  console.log('  Duration:     ' + (Date.now() - now) + 'ms');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Ranked Candidates:');
  console.log('');

  for (const c of result.rankedCandidates) {
    const params = JSON.parse(c.paramsJson);
    console.log('    #' + c.rank + '  ' + c.label.padEnd(25) +
      '  merged=' + c.mergedScore.toFixed(4) +
      '  det=' + c.deterministicScore.toFixed(4) +
      (c.llmScore != null ? '  llm=' + c.llmScore.toFixed(4) : '') +
      '  windows=' + c.windowCount);
    console.log('         params: ' + JSON.stringify(params.params ?? params));
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Aggregate Metrics:');
  console.log('    Score stability:  ' + result.aggregateMetrics.scoreStability.toFixed(4));
  console.log('    Top-K overlap:    ' + result.aggregateMetrics.topKOverlap.toFixed(4));
  if (result.aggregateMetrics.llmConsultationRate != null) {
    console.log('    LLM consultation: ' + result.aggregateMetrics.llmConsultationRate.toFixed(4));
    console.log('    LLM divergence:   ' + result.aggregateMetrics.llmDivergence?.toFixed(4));
  } else {
    console.log('    LLM:              not configured');
  }
  console.log('─────────────────────────────────────────────────────────────');

  dbManager.close();
}

main().catch(err => {
  console.error('Walk-forward evaluator failed:', err);
  process.exit(1);
});
"
