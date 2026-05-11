# Broker Persistence Rename Plan

## Goal
Move persistence table naming from `zerodha_*` to neutral `broker_*` without breaking the currently healthy Upstox MCP runtime, compatibility shims, or restart behavior.

## Current State
Live code now uses neutral runtime/config/broker paths, but SQLite schema and repository SQL still target legacy names:

- `zerodha_session`
- `zerodha_ingestion_events`
- `zerodha_instruments`
- `zerodha_instrument_sync_state`
- `zerodha_latest_quotes`
- `zerodha_stream_state`

This is stable today and verified against the live runtime.

## Risks
1. **Warm-restart regression** — instrument/session/quote state is persisted and currently proven to survive restart on the same DB.
2. **Mixed-version access** — old and new builds may read the same DB during rollout.
3. **Data loss risk** — table rename / copy mistakes would break auth, instrument cache, or quote freshness.
4. **Silent drift** — repository SQL, health surfaces, and tests could point at different table names if migration is partial.

## Recommended Migration Strategy

### Phase 1 — Dual-schema compatibility
- Update `src/persistence/sqlite.ts` to create both legacy and neutral tables or neutral views.
- Teach `BrokerRepository` to detect `broker_*` first, then fall back to `zerodha_*`.
- Keep `ZerodhaRepository` alias exports intact.
- Add file-backed migration tests covering:
  - legacy DB only
  - broker DB only
  - both present

### Phase 2 — One-time data migration
At process boot, if `broker_*` tables are missing and `zerodha_*` tables exist:
- create `broker_*` tables
- copy all rows transactionally
- verify row counts per table before commit
- record a migration marker/version
- keep legacy tables untouched for rollback

### Phase 3 — Switch writes to neutral tables
- Make repository write path target `broker_*`
- Keep read fallback from legacy tables for one release window
- Re-run full suite and live restart verification

### Phase 4 — Optional cleanup
Only after a stable release window:
- drop legacy fallback reads
- optionally archive or drop `zerodha_*` tables
- remove compatibility comments referring to the legacy schema

## Verification Requirements
Before any live schema switch:
- `npm test`
- file-backed restart regression on the same DB path
- live runtime restart on real DB path
- `/health` must remain `healthy`
- `/health/broker` must show:
  - authenticated session
  - non-stale instruments
  - connected/non-stale stream

## Rollback Plan
If migration causes trouble:
- redeploy the current build
- point repository reads/writes back to `zerodha_*`
- keep `broker_*` tables untouched for post-mortem
- do not delete legacy tables during first rollout

## Recommendation
Do **not** rename live tables in the same step as env alias and wording cleanup. The current runtime is healthy; table migration should be a dedicated, separately verified change.
