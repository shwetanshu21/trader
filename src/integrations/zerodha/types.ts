// ── Zerodha integration DTOs ──
// Normalised session/health types distinct from raw broker responses.
// No implementation, no secrets — pure data shapes.

import type { ZerodhaSessionState, ZerodhaSessionRow, ZerodhaSessionHealth } from '../../types/runtime.js';

// Re-export for convenience from the integration boundary
export type { ZerodhaSessionState, ZerodhaSessionRow, ZerodhaSessionHealth };

// ---------------------------------------------------------------------------
// Raw Kite API response shapes (used internally by session-service)
// ---------------------------------------------------------------------------

/** Shape returned by Kite Connect /session/token endpoint on success. */
export interface KiteTokenResponse {
  access_token: string;
  login_time: string;
  // The raw response may include user data; we only extract what we need
}

/** Shape returned by Kite Connect /session/refresh endpoint on success. */
export interface KiteRefreshResponse {
  access_token: string;
  login_time: string;
}

/** Minimal user info returned alongside the token. */
export interface KiteUserInfo {
  user_id: string;
  user_name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Health-facing ingestion event (safe for /health surfaces)
// ---------------------------------------------------------------------------

/** A single ingestion event summary safe for health surfaces. */
export interface IngestionEventHealth {
  eventType: string;
  recordedAt: number;
  durationMs: number | null;
  itemCount: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Composite health block emitted by Zerodha services
// ---------------------------------------------------------------------------

/** Zerodha-specific health block — embedded in the top-level HealthStatus. */
export interface ZerodhaHealthBlock {
  session: ZerodhaSessionHealth;
  ingestion: IngestionEventHealth[];
}
