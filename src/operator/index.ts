// ── Operator query seam — public export surface ──
//
// S02 (operator console) imports from this single entry point rather than
// reaching into internal file paths. Covers:
//   - Read-only database seam: open, verify, close
//   - OperatorReadModel: query-backed aggregates
//   - All operator DTO types with provenance metadata
//
// Usage:
//   import { openOperatorDb, OperatorReadModel, type OperatorSummaryCard }
//     from '../operator/index.js';
//
// No-op commitment: the read-only seam never writes to or migrates the
// underlying database. All types are pure data shapes.

// ── Read-only DB seam ──────────────────────────────────────────────────
export {
  openOperatorDb,
  openOperatorDbOrThrow,
  isReadOnly,
  closeOperatorDb,
} from './read-only-db.js';

export type { OpenOperatorDbResult } from './read-only-db.js';

// ── Read model ─────────────────────────────────────────────────────────
export { OperatorReadModel } from './operator-read-model.js';
export { OperatorDetailReadModel, OperatorDetailReadModelError } from './operator-detail-read-model.js';

// ── Operator DTOs ──────────────────────────────────────────────────────
export type {
  OperatorProvenance,
  OperatorSummaryCard,
  OperatorStrategyPerformance,
  OperatorTickerPerformance,
  OperatorDecisionPerformance,
  OperatorLifecycleState,
  OperatorLifecycleHistory,
  OperatorPromotionHistory,
  OperatorWalkForwardLeaderboard,
  OperatorDecisionReasonDetail,
  OperatorHybridComponentDetail,
  OperatorHybridEvidenceDetail,
  OperatorExecutionAttemptDetail,
  OperatorDecisionRealizedPnlDetail,
  OperatorDecisionDetail,
  OperatorGovernanceDecisionDetail,
  OperatorStrategyWalkForwardDetail,
  OperatorStrategyDetail,
  OperatorBacktestWindowEvidenceDetail,
  OperatorBacktestSelectedTrialDetail,
  OperatorBacktestDetail,
} from '../types/runtime.js';
