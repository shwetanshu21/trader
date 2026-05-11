// ── Health HTTP Server ──
// Lightweight HTTP health endpoint for the Pi runtime.
// Uses Node built-in `http` module — zero extra dependencies.
// Endpoints:
//   GET /health         → HealthStatus JSON (including broker health when configured)
//   GET /health/live    → 200 OK liveness probe (no DB read)
//   GET /health/ready   → 200 if lifecycle is Running or Degraded, 503 otherwise
//   GET /health/broker  → Broker (Zerodha) health block, or 404
//   GET /health/scheduler → Detailed scheduler state

import http from 'node:http';
import type { HealthService } from './health-service.js';
import type { Scheduler } from './scheduler.js';
import type { Telemetry } from './telemetry.js';
import type { DatabaseManager } from '../persistence/sqlite.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthServerOptions {
  healthService: HealthService;
  scheduler: Scheduler;
  telemetry: Telemetry;
  dbManager: DatabaseManager;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHealthServer(
  healthService: HealthService,
  scheduler: Scheduler,
  telemetry: Telemetry,
  dbManager: DatabaseManager,
): http.Server {
  return http.createServer((req, res) => {
    // CORS headers for local health monitoring
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    try {
      switch (url.pathname) {
        case '/health': {
          const status = healthService.getHealth();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status, null, 2));
          break;
        }

        case '/health/live': {
          // Liveness: process is alive and responding
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'alive', uptimeMs: Date.now() - getStartTime() }));
          break;
        }

        case '/health/ready': {
          // Readiness: runtime is functional (Running or Degraded, not Stopped)
          const state = healthService.getHealth();
          const ready = state.lifecycleState !== 'stopped';
          res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ready,
            lifecycleState: state.lifecycleState,
            schedulerStatus: state.scheduler.status,
          }));
          break;
        }

        case '/health/broker': {
          const full = healthService.getHealth();
          if (full.zerodha) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(full.zerodha, null, 2));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Broker not configured' }));
          }
          break;
        }

        case '/health/scheduler': {
          // Detailed scheduler state
          const schedState = scheduler.getState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(schedState, null, 2));
          break;
        }

        default: {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: message }));
    }
  });
}

// ── Simple process-start tracking for liveness ───────────────────────────────

const _processStart = Date.now();

function getStartTime(): number {
  return _processStart;
}
