import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Database manager — schema migration + lifecycle
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lifecycle_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  state     TEXT    NOT NULL,
  reason    TEXT    NOT NULL,
  diagnostic TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  status            TEXT    NOT NULL,
  market_phase      TEXT    NOT NULL,
  last_tick_ts      INTEGER,
  started_at        INTEGER,
  tick_count        INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE TABLE IF NOT EXISTS health_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  verdict         TEXT    NOT NULL,
  uptime_ms       INTEGER NOT NULL,
  lifecycle_state TEXT    NOT NULL,
  degraded_reasons TEXT,
  checked_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS zerodha_session (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT    NOT NULL,
  obtained_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'missing_credentials',
  reason       TEXT    NOT NULL DEFAULT '',
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_ingestion_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT    NOT NULL,
  recorded_at INTEGER NOT NULL,
  duration_ms INTEGER,
  item_count  INTEGER,
  error       TEXT,
  diagnostic  TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_instruments (
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER NOT NULL,
  name              TEXT    NOT NULL DEFAULT '',
  expiry            TEXT,
  strike            REAL,
  lot_size          INTEGER NOT NULL DEFAULT 1,
  tick_size         REAL    NOT NULL DEFAULT 0.05,
  instrument_type   TEXT    NOT NULL,
  segment           TEXT    NOT NULL,
  exchange_token    INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_token ON zerodha_instruments(instrument_token);
CREATE INDEX IF NOT EXISTS idx_instruments_exchange ON zerodha_instruments(exchange);
CREATE INDEX IF NOT EXISTS idx_instruments_segment ON zerodha_instruments(segment);

CREATE TABLE IF NOT EXISTS zerodha_instrument_sync_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at       INTEGER,
  last_instrument_count INTEGER,
  last_skipped_count    INTEGER,
  last_status           TEXT,
  last_error            TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_latest_quotes (
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER NOT NULL,
  last_price        REAL    NOT NULL DEFAULT 0,
  change            REAL,
  change_percent    REAL,
  volume            INTEGER,
  oi                INTEGER,
  high              REAL,
  low               REAL,
  open              REAL,
  close             REAL,
  bid               REAL,
  ask               REAL,
  price_timestamp   INTEGER,
  received_at       INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_latest_quotes_token ON zerodha_latest_quotes(instrument_token);
CREATE INDEX IF NOT EXISTS idx_latest_quotes_received ON zerodha_latest_quotes(received_at);

CREATE TABLE IF NOT EXISTS zerodha_stream_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  state               TEXT    NOT NULL DEFAULT 'disconnected',
  connected_at        INTEGER,
  last_heartbeat_at   INTEGER,
  last_quote_received_at INTEGER,
  reconnect_count     INTEGER NOT NULL DEFAULT 0,
  parse_failures      INTEGER NOT NULL DEFAULT 0,
  subscribed_count    INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER,
  side              TEXT    NOT NULL,
  product           TEXT    NOT NULL,
  quantity          INTEGER NOT NULL,
  price             REAL,
  trigger_price     REAL,
  order_type        TEXT    NOT NULL DEFAULT 'MARKET',
  tag               TEXT,
  proposal_status   TEXT    NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_attempts_lookup ON proposal_attempts(exchange, tradingsymbol);
CREATE INDEX IF NOT EXISTS idx_proposal_attempts_status ON proposal_attempts(proposal_status);
CREATE INDEX IF NOT EXISTS idx_proposal_attempts_created ON proposal_attempts(created_at);

CREATE TABLE IF NOT EXISTS proposal_validation_reasons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id INTEGER NOT NULL REFERENCES proposal_attempts(id),
  reason_code         TEXT    NOT NULL,
  reason_message      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_validation_reasons_attempt ON proposal_validation_reasons(proposal_attempt_id);
CREATE INDEX IF NOT EXISTS idx_validation_reasons_code ON proposal_validation_reasons(reason_code);

CREATE TABLE IF NOT EXISTS blocked_order_attempts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id INTEGER NOT NULL UNIQUE REFERENCES proposal_attempts(id),
  blocked_at          INTEGER NOT NULL,
  block_code          TEXT    NOT NULL,
  block_message       TEXT    NOT NULL DEFAULT '',
  gate_tag            TEXT    NOT NULL DEFAULT '',
  exchange            TEXT    NOT NULL,
  tradingsymbol       TEXT    NOT NULL,
  instrument_token    INTEGER,
  side                TEXT    NOT NULL,
  product             TEXT    NOT NULL,
  quantity            INTEGER NOT NULL,
  price               REAL,
  trigger_price       REAL,
  order_type          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocked_order_blocked_at ON blocked_order_attempts(blocked_at);
CREATE INDEX IF NOT EXISTS idx_blocked_order_proposal ON blocked_order_attempts(proposal_attempt_id);

CREATE TABLE IF NOT EXISTS universe_members (
  exchange       TEXT    NOT NULL,
  tradingsymbol  TEXT    NOT NULL,
  instrument_type TEXT   NOT NULL DEFAULT 'EQ',
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_universe_members_exchange ON universe_members(exchange);

CREATE TABLE IF NOT EXISTS universe_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_version      TEXT    NOT NULL,
  computed_at         INTEGER NOT NULL,
  verdict             TEXT    NOT NULL,
  eligible_count      INTEGER NOT NULL,
  ineligible_count    INTEGER NOT NULL,
  fresh_quote_count   INTEGER NOT NULL,
  stale_quote_count   INTEGER NOT NULL,
  missing_quote_count INTEGER NOT NULL,
  threshold_label     TEXT    NOT NULL,
  threshold_ratio     REAL    NOT NULL,
  max_staleness_ms    INTEGER NOT NULL,
  members_json        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_universe_snapshots_computed ON universe_snapshots(computed_at);

CREATE TABLE IF NOT EXISTS strategy_decisions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id   INTEGER NOT NULL UNIQUE REFERENCES proposal_attempts(id),
  decision_status       TEXT    NOT NULL,
  strategy_id           TEXT    NOT NULL,
  strategy_version      TEXT    NOT NULL,
  decided_at            INTEGER NOT NULL,
  exchange              TEXT    NOT NULL,
  tradingsymbol         TEXT    NOT NULL,
  side                  TEXT    NOT NULL,
  product               TEXT    NOT NULL,
  quantity              INTEGER NOT NULL,
  price                 REAL,
  trigger_price         REAL,
  order_type            TEXT    NOT NULL,

  -- Reference quote snapshot at decision time
  quote_last_price      REAL,
  quote_bid             REAL,
  quote_ask             REAL,
  quote_volume          INTEGER,
  quote_received_at     INTEGER,

  -- Risk metadata
  risk_notional         REAL,
  risk_sizing_basis     TEXT    NOT NULL DEFAULT '',
  risk_max_loss_rupees  REAL,
  risk_stop_distance    REAL,
  risk_stop_price       REAL,
  risk_trailing_stop_distance REAL,
  risk_budget_rupees    REAL,
  risk_exposure_tag     TEXT,
  india_research_evidence TEXT,
  execution_class       TEXT    NOT NULL DEFAULT 'EQ',
  segment               TEXT    NOT NULL DEFAULT 'NSE',
  instrument_type       TEXT    NOT NULL DEFAULT 'EQ',
  expiry                TEXT,
  strike                REAL,
  lot_size              INTEGER NOT NULL DEFAULT 1,
  tick_size             REAL    NOT NULL DEFAULT 0.05,
  freeze_quantity       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_status ON strategy_decisions(decision_status);
CREATE INDEX IF NOT EXISTS idx_strategy_decisions_proposal ON strategy_decisions(proposal_attempt_id);
CREATE INDEX IF NOT EXISTS idx_strategy_decisions_decided ON strategy_decisions(decided_at);

CREATE TABLE IF NOT EXISTS strategy_decision_reasons (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_decision_id  INTEGER NOT NULL REFERENCES strategy_decisions(id),
  reason_code           TEXT    NOT NULL,
  reason_message        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_strategy_reasons_decision ON strategy_decision_reasons(strategy_decision_id);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_decision_id  INTEGER NOT NULL UNIQUE REFERENCES strategy_decisions(id),
  execution_mode        TEXT    NOT NULL,
  status                TEXT    NOT NULL,
  outcome_code          TEXT,
  broker_order_id       TEXT,
  message               TEXT    NOT NULL DEFAULT '',
  attempted_at          INTEGER NOT NULL,
  completed_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_decision ON execution_attempts(strategy_decision_id);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_status ON execution_attempts(status);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_attempted ON execution_attempts(attempted_at);

CREATE TABLE IF NOT EXISTS execution_attempt_refusal_reasons (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_attempt_id  INTEGER NOT NULL REFERENCES execution_attempts(id),
  reason_code           TEXT    NOT NULL,
  reason_message        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_execution_refusal_attempt ON execution_attempt_refusal_reasons(execution_attempt_id);

-- S04: Paper trading persistence tables
CREATE TABLE IF NOT EXISTS paper_orders (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_attempt_id  INTEGER NOT NULL UNIQUE REFERENCES execution_attempts(id),
  exchange              TEXT    NOT NULL,
  tradingsymbol         TEXT    NOT NULL,
  side                  TEXT    NOT NULL,
  product               TEXT    NOT NULL,
  quantity              INTEGER NOT NULL,
  price                 REAL,
  trigger_price         REAL,
  order_type            TEXT    NOT NULL DEFAULT 'MARKET',
  tag                   TEXT,
  status                TEXT    NOT NULL DEFAULT 'pending',
  broker_order_id       TEXT    NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_attempt ON paper_orders(execution_attempt_id);
CREATE INDEX IF NOT EXISTS idx_paper_orders_status ON paper_orders(status);
CREATE INDEX IF NOT EXISTS idx_paper_orders_created ON paper_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol ON paper_orders(exchange, tradingsymbol);

CREATE TABLE IF NOT EXISTS paper_fills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_order_id        INTEGER NOT NULL REFERENCES paper_orders(id),
  execution_attempt_id  INTEGER NOT NULL UNIQUE REFERENCES execution_attempts(id),
  exchange              TEXT    NOT NULL,
  tradingsymbol         TEXT    NOT NULL,
  side                  TEXT    NOT NULL,
  product               TEXT    NOT NULL,
  filled_quantity       INTEGER NOT NULL,
  filled_price          REAL    NOT NULL,
  reference_price       REAL,
  slippage_per_unit     REAL    NOT NULL DEFAULT 0,
  slippage_amount       REAL    NOT NULL DEFAULT 0,
  fees                  REAL    NOT NULL DEFAULT 0,
  broker_order_id       TEXT    NOT NULL,
  filled_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_fills_order ON paper_fills(paper_order_id);
CREATE INDEX IF NOT EXISTS idx_paper_fills_attempt ON paper_fills(execution_attempt_id);
CREATE INDEX IF NOT EXISTS idx_paper_fills_filled ON paper_fills(filled_at);
CREATE INDEX IF NOT EXISTS idx_paper_fills_symbol ON paper_fills(exchange, tradingsymbol);

CREATE TABLE IF NOT EXISTS position_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_order_id        INTEGER NOT NULL REFERENCES paper_orders(id),
  paper_fill_id         INTEGER REFERENCES paper_fills(id),
  execution_attempt_id  INTEGER NOT NULL REFERENCES execution_attempts(id),
  event_type            TEXT    NOT NULL,
  exchange              TEXT    NOT NULL,
  tradingsymbol         TEXT    NOT NULL,
  product               TEXT    NOT NULL,
  quantity_delta        INTEGER NOT NULL,
  price                 REAL    NOT NULL,
  previous_quantity     INTEGER NOT NULL,
  previous_avg_cost     REAL    NOT NULL,
  new_quantity          INTEGER NOT NULL,
  new_avg_cost          REAL    NOT NULL,
  realized_pnl          REAL    NOT NULL DEFAULT 0,
  transaction_fees      REAL    NOT NULL DEFAULT 0,
  stop_price            REAL,
  trailing_anchor_price REAL,
  trailing_stop_distance REAL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_events_order ON position_events(paper_order_id);
CREATE INDEX IF NOT EXISTS idx_position_events_fill ON position_events(paper_fill_id);
CREATE INDEX IF NOT EXISTS idx_position_events_attempt ON position_events(execution_attempt_id);
CREATE INDEX IF NOT EXISTS idx_position_events_symbol ON position_events(exchange, tradingsymbol);
CREATE INDEX IF NOT EXISTS idx_position_events_created ON position_events(created_at);

CREATE TABLE IF NOT EXISTS paper_positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange        TEXT    NOT NULL,
  tradingsymbol   TEXT    NOT NULL,
  product         TEXT    NOT NULL,
  side            TEXT    NOT NULL DEFAULT 'flat',
  quantity        INTEGER NOT NULL DEFAULT 0,
  avg_cost_price  REAL    NOT NULL DEFAULT 0,
  realized_pnl    REAL    NOT NULL DEFAULT 0,
  stop_price      REAL,
  trailing_anchor_price REAL,
  trailing_stop_distance REAL,
  mark_price      REAL,
  marked_at       INTEGER,
  updated_at      INTEGER NOT NULL,
  UNIQUE(exchange, tradingsymbol, product)
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_side ON paper_positions(side);
CREATE INDEX IF NOT EXISTS idx_paper_positions_open ON paper_positions(quantity) WHERE quantity != 0;

-- S05: Execution risk state singleton table
CREATE TABLE IF NOT EXISTS execution_risk_state (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  halt_state                TEXT    NOT NULL DEFAULT 'no_halt',
  halt_source               TEXT,
  halt_reason               TEXT,
  halted_at                 INTEGER,
  acknowledged_at           INTEGER,
  open_position_count_at_halt INTEGER,
  daily_pnl_at_halt         REAL,
  latch_count               INTEGER NOT NULL DEFAULT 0,
  updated_at                INTEGER NOT NULL
);

-- S05: Append-only risk events
CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT    NOT NULL,
  source      TEXT,
  severity    TEXT    NOT NULL DEFAULT 'info',
  message     TEXT    NOT NULL DEFAULT '',
  diagnostic  TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_events_recorded ON risk_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type);
CREATE INDEX IF NOT EXISTS idx_risk_events_severity ON risk_events(severity);

-- S02: Hybrid scoring audit trail tables
CREATE TABLE IF NOT EXISTS hybrid_score_summary (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id   INTEGER NOT NULL UNIQUE REFERENCES proposal_attempts(id),
  deterministic_score   REAL    NOT NULL,
  llm_score             REAL,
  llm_status            TEXT    NOT NULL,
  llm_rationale         TEXT,
  merged_score          REAL    NOT NULL,
  merge_policy          TEXT    NOT NULL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hybrid_score_proposal ON hybrid_score_summary(proposal_attempt_id);
CREATE INDEX IF NOT EXISTS idx_hybrid_score_created ON hybrid_score_summary(created_at);

CREATE TABLE IF NOT EXISTS hybrid_score_components (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id      INTEGER NOT NULL REFERENCES hybrid_score_summary(id),
  component_name  TEXT    NOT NULL,
  score           REAL    NOT NULL,
  weight          REAL    NOT NULL,
  sort_order      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hybrid_components_summary ON hybrid_score_components(summary_id);
CREATE INDEX IF NOT EXISTS idx_hybrid_components_order ON hybrid_score_components(summary_id, sort_order);

-- M005/S01: Replay sessions — durable replay run state
CREATE TABLE IF NOT EXISTS replay_sessions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  label                 TEXT    NOT NULL,
  strategy_id           TEXT    NOT NULL,
  strategy_version      TEXT    NOT NULL,
  market_id             TEXT    NOT NULL,
  cadence_minutes       INTEGER NOT NULL DEFAULT 5,
  range_start           INTEGER NOT NULL,
  range_end             INTEGER NOT NULL,
  requested_fidelity    TEXT    NOT NULL,
  effective_fidelity    TEXT,
  status                TEXT    NOT NULL DEFAULT 'pending',
  total_ticks           INTEGER NOT NULL DEFAULT 0,
  completed_ticks       INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_replay_sessions_status ON replay_sessions(status);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_created ON replay_sessions(created_at);

-- M005/S01: Replay checkpoints — resumable position within a session
CREATE TABLE IF NOT EXISTS replay_checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES replay_sessions(id),
  tick_index      INTEGER NOT NULL,
  tick_timestamp  INTEGER NOT NULL,
  strategy_run_id INTEGER REFERENCES strategy_runs(id),
  metadata_json   TEXT,
  saved_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_checkpoints_session ON replay_checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_replay_checkpoints_tick ON replay_checkpoints(session_id, tick_index);

-- S05: Strategy run — append-only replay-ready artifact for screening rounds
CREATE TABLE IF NOT EXISTS strategy_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_config      TEXT    NOT NULL,
  plugins_json          TEXT    NOT NULL,
  plugin_errors_json    TEXT,
  universe_snapshot_id  INTEGER REFERENCES universe_snapshots(id),
  total_evaluated       INTEGER NOT NULL,
  has_plugin_errors     INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_runs_created ON strategy_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_runs_snapshot ON strategy_runs(universe_snapshot_id);

-- S05: Strategy run candidates — one row per candidate identity within a run
CREATE TABLE IF NOT EXISTS strategy_run_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_run_id       INTEGER NOT NULL REFERENCES strategy_runs(id),
  candidate_key         TEXT    NOT NULL,
  rank                  INTEGER NOT NULL,
  exchange              TEXT    NOT NULL,
  tradingsymbol         TEXT    NOT NULL,
  instrument_token      INTEGER,
  instrument_type       TEXT    NOT NULL DEFAULT 'EQ',
  lot_size              INTEGER NOT NULL DEFAULT 1,
  tick_size             REAL    NOT NULL DEFAULT 0.05,
  expiry                TEXT,
  strike                REAL,
  freeze_quantity       INTEGER,
  side                  TEXT    NOT NULL,
  last_price            REAL,
  bid                   REAL,
  ask                   REAL,
  volume                INTEGER,
  scores_json           TEXT    NOT NULL,
  deterministic_score   REAL    NOT NULL,
  llm_score             REAL,
  llm_status            TEXT,
  llm_rationale         TEXT,
  merged_score          REAL    NOT NULL,
  merge_policy          TEXT,
  proposal_params_json  TEXT,
  plugin_errors_json    TEXT,
  has_plugin_errors     INTEGER NOT NULL DEFAULT 0,
  emitted               INTEGER NOT NULL DEFAULT 0,
  proposal_attempt_id   INTEGER REFERENCES proposal_attempts(id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_run_candidates_run ON strategy_run_candidates(strategy_run_id);
CREATE INDEX IF NOT EXISTS idx_strategy_run_candidates_rank ON strategy_run_candidates(strategy_run_id, rank);
CREATE INDEX IF NOT EXISTS idx_strategy_run_candidates_key ON strategy_run_candidates(strategy_run_id, candidate_key);
CREATE INDEX IF NOT EXISTS idx_strategy_run_candidates_proposal ON strategy_run_candidates(proposal_attempt_id);
CREATE INDEX IF NOT EXISTS idx_strategy_run_candidates_emitted ON strategy_run_candidates(strategy_run_id, emitted);

-- M005/S02: Walk-forward runs — top-level evaluation run
CREATE TABLE IF NOT EXISTS walk_forward_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  label                 TEXT    NOT NULL,
  strategy_id           TEXT    NOT NULL,
  strategy_version      TEXT    NOT NULL,
  market_id             TEXT    NOT NULL,
  replay_session_id     INTEGER REFERENCES replay_sessions(id),
  window_count          INTEGER NOT NULL DEFAULT 0,
  total_trials          INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'pending',
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON walk_forward_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_created ON walk_forward_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_wf_runs_session ON walk_forward_runs(replay_session_id);

-- M005/S02: Walk-forward windows — rolling-window segments within a run
CREATE TABLE IF NOT EXISTS walk_forward_windows (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                  INTEGER NOT NULL REFERENCES walk_forward_runs(id),
  window_index            INTEGER NOT NULL,
  range_start             INTEGER NOT NULL,
  range_end               INTEGER NOT NULL,
  window_label            TEXT    NOT NULL DEFAULT '',
  trial_count_optimized   INTEGER NOT NULL DEFAULT 0,
  trial_count_tested      INTEGER NOT NULL DEFAULT 0,
  status                  TEXT    NOT NULL DEFAULT 'pending',
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_windows_run ON walk_forward_windows(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_windows_index ON walk_forward_windows(run_id, window_index);

-- M005/S02: Walk-forward trials — optimization trials within a run
CREATE TABLE IF NOT EXISTS walk_forward_trials (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES walk_forward_runs(id),
  trial_index           INTEGER NOT NULL,
  label                 TEXT    NOT NULL,
  params_json           TEXT    NOT NULL,
  merged_score          REAL    NOT NULL,
  deterministic_score   REAL    NOT NULL,
  llm_score             REAL,
  llm_status            TEXT,
  rank                  INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_trials_run ON walk_forward_trials(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_trials_rank ON walk_forward_trials(run_id, rank);

-- M005/S02: Walk-forward trial-window evidence — per-window outcomes for each trial
CREATE TABLE IF NOT EXISTS walk_forward_trial_windows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id              INTEGER NOT NULL REFERENCES walk_forward_trials(id),
  window_id             INTEGER NOT NULL REFERENCES walk_forward_windows(id),
  window_type           TEXT    NOT NULL,
  total_return          REAL    NOT NULL,
  sharpe_ratio          REAL,
  max_drawdown          REAL,
  win_rate              REAL,
  trade_count           INTEGER NOT NULL DEFAULT 0,
  profit_factor         REAL,
  metrics_json          TEXT,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_tw_trial ON walk_forward_trial_windows(trial_id);
CREATE INDEX IF NOT EXISTS idx_wf_tw_window ON walk_forward_trial_windows(window_id);
CREATE INDEX IF NOT EXISTS idx_wf_tw_trial_window ON walk_forward_trial_windows(trial_id, window_id);

-- M005 remediation: Walk-forward checkpoints — append-only durable progress for resume
CREATE TABLE IF NOT EXISTS walk_forward_checkpoints (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                    INTEGER NOT NULL REFERENCES walk_forward_runs(id),
  completed_trial_count     INTEGER NOT NULL DEFAULT 0,
  last_completed_trial_index INTEGER,
  metadata_json             TEXT,
  saved_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_run ON walk_forward_checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_saved ON walk_forward_checkpoints(run_id, saved_at);

-- M005/S03: Walk-forward winners — persisted winner-selection decisions
CREATE TABLE IF NOT EXISTS walk_forward_winners (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                  INTEGER NOT NULL UNIQUE REFERENCES walk_forward_runs(id),
  result                  TEXT    NOT NULL,
  selected_trial_id       INTEGER REFERENCES walk_forward_trials(id),
  selection_strategy      TEXT    NOT NULL,
  selection_config_json   TEXT    NOT NULL DEFAULT '{}',
  rationale               TEXT    NOT NULL DEFAULT '',
  artifact_paths_json     TEXT,
  selected_at             INTEGER NOT NULL,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_winners_run ON walk_forward_winners(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_winners_result ON walk_forward_winners(result);
CREATE INDEX IF NOT EXISTS idx_wf_winners_trial ON walk_forward_winners(selected_trial_id);

-- M006/S01: Strategy lifecycle state — current-phase singleton per strategy identity
CREATE TABLE IF NOT EXISTS strategy_lifecycle_state (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id       TEXT    NOT NULL,
  strategy_version  TEXT    NOT NULL,
  market_id         TEXT    NOT NULL,
  phase             TEXT    NOT NULL DEFAULT 'backtest',
  updated_at        INTEGER NOT NULL,
  UNIQUE(strategy_id, strategy_version, market_id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_state_identity ON strategy_lifecycle_state(strategy_id, strategy_version, market_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_state_phase ON strategy_lifecycle_state(phase);

-- M006/S01: Governance decisions — append-only log
CREATE TABLE IF NOT EXISTS governance_decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id       TEXT    NOT NULL,
  strategy_version  TEXT    NOT NULL,
  market_id         TEXT    NOT NULL,
  verdict           TEXT    NOT NULL,
  previous_phase    TEXT    NOT NULL,
  new_phase         TEXT    NOT NULL,
  rationale         TEXT    NOT NULL DEFAULT '',
  evidence_json     TEXT,
  winner_id         INTEGER REFERENCES walk_forward_winners(id),
  recorded_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gov_decisions_identity ON governance_decisions(strategy_id, strategy_version, market_id);
CREATE INDEX IF NOT EXISTS idx_gov_decisions_recorded ON governance_decisions(recorded_at);
CREATE INDEX IF NOT EXISTS idx_gov_decisions_verdict ON governance_decisions(verdict);
`;

export class DatabaseManager {
  private _db: Database.Database;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);

    // Enable WAL for concurrent-read performance
    this._db.pragma('journal_mode = WAL');

    // Enforce foreign key constraints
    this._db.pragma('foreign_keys = ON');

    // Run migrations
    this._db.exec(SCHEMA_SQL);

    // Migrate S02 columns for India research evidence (idempotent — only adds if missing)
    this._migrateAddColumnIfNotExists('strategy_run_candidates', 'india_research_evidence', 'TEXT');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'india_research_evidence', 'TEXT');

    // Migrate S05 columns for FO instrument metadata (idempotent)
    this._migrateAddColumnIfNotExists('strategy_run_candidates', 'expiry', 'TEXT');
    this._migrateAddColumnIfNotExists('strategy_run_candidates', 'strike', 'REAL');
    this._migrateAddColumnIfNotExists('strategy_run_candidates', 'freeze_quantity', 'INTEGER');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'execution_class', "TEXT NOT NULL DEFAULT 'EQ'");
    this._migrateAddColumnIfNotExists('strategy_decisions', 'segment', "TEXT NOT NULL DEFAULT 'NSE'");
    this._migrateAddColumnIfNotExists('strategy_decisions', 'instrument_type', "TEXT NOT NULL DEFAULT 'EQ'");
    this._migrateAddColumnIfNotExists('strategy_decisions', 'expiry', 'TEXT');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'strike', 'REAL');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'lot_size', 'INTEGER NOT NULL DEFAULT 1');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'tick_size', 'REAL NOT NULL DEFAULT 0.05');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'freeze_quantity', 'INTEGER');

    // M007 quick-task: dynamic sizing / stop state columns (idempotent)
    this._migrateAddColumnIfNotExists('strategy_decisions', 'risk_stop_price', 'REAL');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'risk_trailing_stop_distance', 'REAL');
    this._migrateAddColumnIfNotExists('strategy_decisions', 'risk_budget_rupees', 'REAL');
    this._migrateAddColumnIfNotExists('position_events', 'stop_price', 'REAL');
    this._migrateAddColumnIfNotExists('position_events', 'trailing_anchor_price', 'REAL');
    this._migrateAddColumnIfNotExists('position_events', 'trailing_stop_distance', 'REAL');
    this._migrateAddColumnIfNotExists('position_events', 'transaction_fees', 'REAL NOT NULL DEFAULT 0');
    this._migrateAddColumnIfNotExists('paper_fills', 'reference_price', 'REAL');
    this._migrateAddColumnIfNotExists('paper_fills', 'slippage_per_unit', 'REAL NOT NULL DEFAULT 0');
    this._migrateAddColumnIfNotExists('paper_fills', 'slippage_amount', 'REAL NOT NULL DEFAULT 0');
    this._migrateAddColumnIfNotExists('paper_fills', 'fees', 'REAL NOT NULL DEFAULT 0');
    this._migrateAddColumnIfNotExists('paper_positions', 'stop_price', 'REAL');
    this._migrateAddColumnIfNotExists('paper_positions', 'trailing_anchor_price', 'REAL');
    this._migrateAddColumnIfNotExists('paper_positions', 'trailing_stop_distance', 'REAL');
    this._migrateAddColumnIfNotExists('paper_positions', 'mark_price', 'REAL');
    this._migrateAddColumnIfNotExists('paper_positions', 'marked_at', 'INTEGER');
  }

  /** Add a column to a table only if it does not already exist. */
  private _migrateAddColumnIfNotExists(table: string, column: string, def: string): void {
    const cols = this._db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.find(c => c.name === column)) {
      this._db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  }

  /** Expose the underlying better-sqlite3 Database handle. */
  get db(): Database.Database {
    return this._db;
  }

  /** Close the database connection gracefully. */
  close(): void {
    this._db.close();
  }
}
