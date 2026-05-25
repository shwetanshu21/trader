# Project Status Report

**Project**: Trader  
**Date**: 2026-05-25  
**Environment**: Node.js ≥ 22, TypeScript, SQLite  
**Repo State**: Clean working tree

---

## 1. Executive Summary

This is an **autonomous algorithmic trading system** targeting Indian equity markets (NSE via Upstox). It is a long-running Node.js process that combines a tick-based market scheduler, an LLM-driven research pipeline, paper/live execution gating, and a web-based operator console. There is no client-side SPA; all UI is server-rendered HTML served by embedded HTTP servers.

---

## 2. Backend Analysis

### 2.1 Technology Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Runtime | Node.js (≥ 22) | Native `http` module; no Express/Fastify |
| Language | TypeScript (strict, ES2022, NodeNext) | Compiled to `dist/` for production |
| Dev / Watch | `tsx` | `tsx watch src/main.ts` |
| Testing | Vitest (v2.1) | 100+ test files; unit, integration, proof/witness tests |
| Validation | Zod | Runtime schema validation across boundaries |

### 2.2 Architecture

The backend is built around a **single-process, event-tick scheduler** rather than a request/response web server.

- **Entry Point**: `src/main.ts` bootstraps a `RuntimeApp` composition root.
- **Core Loop**: A `Scheduler` tick loop orchestrates market-phase transitions (PreMarket → Regular → PostMarket → Closed).
- **HTTP Servers**: Two lightweight `http.createServer` instances are embedded:
  1. **Runtime Health Server** (port `3000`) — health probes, dashboards, telemetry.
  2. **Operator UI Server** (port `3100`) — authenticated operator console with page routing.

**Key Design Patterns**:
- **Composition Root**: `RuntimeApp` wires repositories, services, and supervisors.
- **Supervisor Pattern**: Each subsystem (Broker, Proposal, Execution, Strategy Risk, Universe, Overnight) has a supervisor that manages its lifecycle.
- **Read Models**: `DashboardReadModel`, `OperatorReadModel`, and detail read models provide query-optimized views for rendering.

### 2.3 Database & Persistence

- **Engine**: SQLite via `better-sqlite3` (synchronous, WAL enabled, foreign keys enforced).
- **Path**: Configurable via `TRADER_DB_PATH` (defaults to `./data/trader.db`).
- **Schema**: ~30 tables covering every subsystem:
  - Runtime telemetry (`scheduler_state`, `health_checks`, `lifecycle_events`)
  - Broker data (`zerodha_session`, `zerodha_instruments`, `zerodha_latest_quotes`)
  - Proposal pipeline (`proposal_attempts`, `blocked_order_attempts`)
  - Strategy & execution (`strategy_decisions`, `execution_attempts`)
  - Paper trading ledger (`paper_orders`, `paper_fills`, `paper_positions`, `position_events`)
  - Risk (`execution_risk_state`, `risk_events`)
  - Scoring & backtesting (`hybrid_score_summary`, `strategy_runs`, `walk_forward_runs`, `walk_forward_windows`, `walk_forward_trials`)
  - LLM research (`hypothesis_graphs`, `hypothesis_memory_ledger`, `hypothesis_generation_attempts`, `research_artifacts`, `research_publications`)
  - Governance (`strategy_lifecycle_state`, `governance_decisions`, `overnight_runs`)

### 2.4 Core Features & Subsystems

#### Autonomous Trading Scheduler
- Tick-based loop aligned to NSE market phases (`MarketClock`).
- Orchestrates broker sync → universe evaluation → proposal generation → strategy risk evaluation → execution gating.

#### Broker Integration (Upstox)
- OAuth 2.0 access token management with automatic refresh.
- Dual transport support: **Direct** (REST API with API key/secret/TOTP) and **MCP** (Model Context Protocol).
- Instrument sync and live quote streaming.

#### Proposal Engine
- Integrates with an external LLM provider (custom or OpenAI-compatible).
- `IndiaProposalValidator` performs domain-specific validation on generated proposals.

#### Execution Gating
- Three modes: `blocked` (audit-only), `paper` (simulated fills), `live` (real orders).
- `ExecutionRiskGuard` enforces kill-switches, daily PnL loss limits, max open positions, max exposure, and duplicate-order prevention.

#### Paper Trading Engine
- Full double-entry ledger: orders, fills, position events.
- Tracks realized / unrealized PnL, average cost, stop-loss, and trailing-stop.

#### Backtesting & Walk-Forward Analysis
- Replay sessions with historical data.
- Rolling-window optimization, trial evaluation, and automated winner selection (`select:winner`).

#### Overnight Research (Autonomous)
- After-hours pipeline that generates strategy hypotheses via LLM.
- Hypotheses are validated, deduplicated via an exact-failure memory ledger, and evaluated via walk-forward replay.
- Can use isolated workspaces / separate DB paths for safety.

#### Governance Framework
- Strategies progress through lifecycle phases: `backtest` → `paper` → `live`.
- Promotion/demotion based on Sharpe ratio, drawdown, window count, and replay fidelity thresholds.

#### Model Context Protocol (MCP)
- Implements an MCP client (`KiteMcpClient`) and a local MCP server (`upstox/mcp-local-server.ts`).
- Exposes trading tools to LLM agents for external interaction.

### 2.5 API Endpoints

#### Runtime Health Server (`:3000`)
- `GET /health` — Full runtime health JSON.
- `GET /health/live` — Liveness probe.
- `GET /health/ready` — Readiness probe (503 if stopped).
- `GET /health/broker`, `/health/scheduler`, `/health/universe`, `/health/strategy`, `/health/execution`, `/health/lifecycle` — Subsystem evidence.
- `GET /dashboard` — HTML runtime dashboard.
- `GET /dashboard.json` — JSON snapshot of runtime dashboard.

#### Operator UI Server (`:3100`)
- `GET /` — Main operator dashboard.
- `GET /positions`, `/strategies`, `/decisions`, `/governance`, `/system-health` — Top-level pages.
- `GET /decision?id={id}` — Decision detail.
- `GET /strategy?strategyId={id}&strategyVersion={v}` — Strategy detail.
- `GET /backtest?runId={id}` — Backtest detail.
- `GET /api/refresh` — Polling endpoint returning JSON + HTML fragments for dynamic section updates.
- `GET /api/health` — Operator service diagnostics.
- `POST /api/upstox/token-refresh` & `POST /system-health/upstox/token-refresh` — Manual token refresh.

### 2.6 Authentication & Authorization

- **Operator UI**: HTTP Basic Auth.
  - Username/password via `OPERATOR_UI_USERNAME` / `OPERATOR_UI_PASSWORD`.
  - Per-IP sliding-window rate limiting.
  - Consecutive-failure lockout (`OPERATOR_UI_LOCKOUT_THRESHOLD`).
  - All auth state is **in-memory** (resets on restart).
- **Broker (Upstox)**: OAuth 2.0 + TOTP-based login flow.
- **MCP**: Optional bearer token support.

---

## 3. Frontend Analysis

### 3.1 Technology Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Framework | None | No React, Vue, Angular, or Svelte |
| Rendering | SSR HTML strings | TypeScript template literals in `src/operator-ui/` |
| Styling | Custom dark-theme CSS | Embedded in `render-utils.ts`; CSS variables, grid/flex, responsive breakpoints |
| Interactivity | Minimal JS | Server-side polling via `/api/refresh`; HTML fragment swaps |

### 3.2 Architecture

- **No Client-Side Router**: Routing is done by matching URL pathname strings inside raw `http.createServer` request handlers.
- **Page Generation**: Each page is a function that returns a complete HTML document string, assembled via shared layout helpers.
- **Navigation**: Persistent sidebar rendered by `renderOperatorConsoleNav()` with links to all top-level sections.

### 3.3 Pages & Components

All pages live in `src/operator-ui/pages/`:

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Summary cards, performance tables, lifecycle states, governance history, walk-forward leaderboard, research lineage, overnight status |
| Positions | `/positions` | Open positions, concentration metrics, exposure proxies |
| Strategies | `/strategies` | Strategy performance tables, attributed exposure |
| Decisions | `/decisions` | Recent decisions and execution outcome evidence |
| Governance | `/governance` | Lifecycle history and walk-forward evidence |
| System Health | `/system-health` | Operator API health, DB bootstrap, auth summary, Upstox token status |
| Decision Detail | `/decision?id={id}` | Drill-down for a single decision |
| Strategy Detail | `/strategy?...` | Drill-down for a single strategy version |
| Backtest Detail | `/backtest?runId={id}` | Drill-down for a single backtest run |

### 3.4 Shared Utilities

- **`render-utils.ts`**: HTML escaping, INR currency formatting, number formatting, CSS framework, table rendering helpers, and page layout wrappers.
- **`DashboardPayloadAssembler`**: Aggregates data from read models into a unified dashboard payload with per-section staleness and error tracking.

### 3.5 Dynamic Updates

- The dashboard uses a **polling model**: the client (or a meta-refresh) calls `/api/refresh`, which returns JSON and HTML fragments.
- Sections are updated server-side and swapped into the DOM without a full page reload, but there is no WebSocket or SSE usage.

---

## 4. Build, Tooling & Scripts

- **Build**: `tsc` compiles `src/` → `dist/`; production run uses `node --experimental-specifier-resolution=node dist/main.js`.
- **Scripts** (from `package.json`):
  - `dev`, `start`, `build`, `test`, `test:watch`
  - `witness:*` — Deployment witness capture / verification
  - `proof:*` — Paper, research, and operator proof verification
  - `overnight:cli` — Standalone overnight research runner
  - `start:upstox:*` — Upstox notifier and MCP local server
  - `select:winner`, `run:upstox`, `promote` — Walk-forward pipeline

---

## 5. Notable Design Decisions

1. **No Web Framework**: The entire backend runs on Node.js native `http`, keeping dependencies minimal and the runtime lightweight.
2. **No SPA / No Bundler**: The frontend is pure server-rendered HTML. This eliminates build-step complexity for the UI but limits rich client-side interactivity.
3. **Append-Only Auditability**: SQLite is used as an append-only event store. Every proposal, decision, execution, risk event, hypothesis, and walk-forward window is persisted for forensic reconstruction.
4. **LLM as a First-Class Citizen**: The system treats LLM-generated hypotheses and proposals as core inputs, with rigorous validation, deduplication, and governance before they reach execution.
5. **Research Isolation**: Overnight research can run in isolated workspaces with separate DB paths to prevent corruption of production trading state.

---

## 6. Summary / Current Status

| Area | Status | Notes |
|------|--------|-------|
| Backend Runtime | ✅ Operational | Native Node.js scheduler with embedded health server |
| Database Schema | ✅ Mature | ~30 tables covering trading, research, governance, and telemetry |
| Broker Integration | ✅ Active | Upstox OAuth + TOTP; direct and MCP transports |
| Proposal & Strategy | ✅ Active | LLM-driven with domain validation and risk gating |
| Execution | ✅ Active | Blocked / Paper / Live modes with full risk guard |
| Paper Trading | ✅ Active | Full ledger with PnL and position tracking |
| Backtesting | ✅ Active | Replay + walk-forward with automated winner selection |
| Overnight Research | ✅ Active | Autonomous LLM hypothesis generation and evaluation |
| Operator Console | ✅ Active | SSR HTML dashboard on port 3100 with Basic Auth |
| Test Coverage | ✅ Strong | 100+ Vitest files across unit, integration, and proof tests |
| MCP Integration | ✅ Active | Local MCP server and client for external LLM agent access |

The project is a **production-grade, fully autonomous trading stack** with an emphasis on auditability, risk management, and LLM-driven research. The absence of a traditional web framework or SPA is an intentional trade-off for runtime simplicity and reliability.
