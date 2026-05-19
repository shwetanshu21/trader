# Hetzner Upstox Walk-Forward Findings

## Summary

This document records the Hetzner deployment investigation and replay/backtest fixes for the Upstox-backed walk-forward path.

## Findings

### 1. Historical endpoint typo blocked all backtests
- Broken path: `/v2/historical-candles/...`
- Correct path: `/v2/historical-candle/...`
- Impact: every historical fetch returned `404 UDAPI100060 Resource not Found`, so winner selection always degraded to `HOLD` with no usable evidence.

### 2. Upstox 1-minute historical API enforces bounded date windows
- After fixing the endpoint, long 1-minute fetches returned `400 UDAPI1148 Invalid date range`.
- Impact: ranges like `2026-04-01 -> 2026-05-16` must be chunked into smaller windows before replay can preload candles.

### 3. Production historical candle timestamps arrive as ISO-8601 strings
- Upstox historical candles return timestamps like `2026-04-30T15:29:00+05:30`.
- The replay provider must normalize them to epoch milliseconds and sort them ascending before binary-search lookup.

### 4. Hetzner runtime was not under systemd
- Runtime and sidecars were launched ad hoc under root.
- Impact: stale quote flow, duplicate runtimes, weak restart behavior, and no clean dependency ordering.

## Code changes

### Replay/data fixes
- `src/upstox/upstox-rest-client.ts`
  - fixed historical endpoint path
  - normalizes raw ISO timestamps to epoch ms
  - sorts historical candles ascending
- `src/replay/upstox-historical-data-provider.ts`
  - chunks long historical 1-minute fetches
  - merges chunk results per instrument
- `src/replay/upstox-date-range.ts`
  - shared date parsing/chunk helpers
- `src/replay/walk-forward-runner-upstox-main.ts`
- `src/replay/walk-forward-select-winner-upstox-main.ts`
  - use inclusive CLI end-date handling

### Test coverage
- `tests/upstox-date-range.test.ts`
- `tests/upstox-rest-client.test.ts`
- `tests/upstox-historical-data-provider.test.ts`
- `tests/walk-forward-evaluator-upstox.test.ts`
- `tests/upstox-mcp-local.test.ts`

## Verification evidence

### Local test suite
- `npx tsc --noEmit`
- `npx vitest run tests/upstox-date-range.test.ts tests/upstox-rest-client.test.ts tests/upstox-historical-data-provider.test.ts tests/walk-forward-evaluator-upstox.test.ts tests/upstox-mcp-local.test.ts`

### Hetzner live probe
- Server: `178.104.167.248`
- Historical probe for `NSE_EQ|INE585B01010`
- Result after endpoint fix:
  - HTTP `200`
  - API status `success`
  - candle count `750`

### Hetzner walk-forward notes
- Long-range run after endpoint fix no longer 404s.
- Short valid proof window succeeded against live Upstox data:
  - label: `hetzner-short-window-2026-05-12_2026-05-16`
  - run id: `3`
  - windows: `3`
  - trials: `4`
  - verdict: `HOLD`
  - artifacts:
    - `data/artifacts/walk-forward/3/winner.json`
    - `data/artifacts/walk-forward/3/diagnostics.json`
    - `data/artifacts/walk-forward/3/trade-log.json`
- Broader medium-window proof also succeeded against live Upstox data:
  - label: `hetzner-medium-window-2026-04-15_2026-05-16`
  - run id: `4`
  - instruments: `10`
  - chunks: `2`
  - windows: `14`
  - trials: `4`
  - verdict: `HOLD`
  - artifacts:
    - `data/artifacts/walk-forward/4/winner.json`
    - `data/artifacts/walk-forward/4/diagnostics.json`
    - `data/artifacts/walk-forward/4/trade-log.json`
- This proves the fixed source can fetch, normalize, cache, chunk, and evaluate real historical candle data on Hetzner across a materially larger range.

## Deployment notes
- Domain front door: `details.aeroinference.com`
- Caddy routes:
  - `/upstox/*` -> notifier on `127.0.0.1:8788`
  - operator dashboard -> runtime on `127.0.0.1:3001`
- Managed services now running on Hetzner:
  - `trader-upstox-notifier.service`
  - `trader-upstox-mcp-local.service`
  - `trader.service`
- **Runtime execution mode: paper** (switched from blocked on 2026-05-17)
  - Command: `TRADER_EXECUTION_MODE=paper` in `.env` + `systemctl restart trader.service`
  - Execution gate refuses: `false`
  - Strategy lifecycle: paper (promoted via walk-forward run 5)
- Post-cutover steady-state witness:
  - bundle: `data/artifacts/deployment-witness/steady-2026-05-17T14-19-01-249Z`
  - manifest: `data/artifacts/deployment-witness/steady-2026-05-17T14-19-01-249Z/manifest.json`
  - verdict: `PASS`

## Remaining caveats
- The Hetzner host had a dirty `/root/trader` working tree during deploy; the safe deploy path was to stash server-local changes, fast-forward `main`, then restart the systemd units.
- After deploy on 2026-05-18, all three managed services were active and listening on `127.0.0.1:8788`, `127.0.0.1:8787`, and `127.0.0.1:3001`.
- The runtime stayed operational but broker-degraded because the Upstox notifier token at `/root/trader/tmp/upstox/notifier/latest-token.json` was expired.
- Journal signature for this failure mode:
  - `MCP tool "get-profile" returned an error: Upstox token ... expired`
  - `Universe coverage is degraded: 0/50 fresh quotes`
- Runtime quote freshness still needs a steady-state verification pass after refreshing the token.
