# CAX11 Deployment Witness — operator runbook

Documents the blocked-mode deployment-witness capture seam for the CAX11 host.
Created as part of **M007/S01** (host witness contract and measurement seam).

## Table of Contents

1. [What this proves](#what-this-proves)
2. [Prerequisites](#prerequisites)
3. [One command](#one-command)
4. [Expected artifacts](#expected-artifacts)
5. [Redaction guarantees](#redaction-guarantees)
6. [Inspecting subsystem evidence](#inspecting-subsystem-evidence)
7. [Failure states](#failure-states)
8. [S01 vs S02: contract capture vs steady-state sizing](#s01-vs-s02-contract-capture-vs-steady-state-sizing)
9. [Cross-references](#cross-references)

---

## What this proves

The deployment witness proves, at a single point in time, that the CAX11 blocked-mode
deployment boundary is **enumerateable** — that every subsystem defined in the roadmap
contract (runtime, notifier, MCP bridge, Caddy/basic-auth front door, SQLite database,
log directories, artifact directories) can be discovered, reached, and photographed
with synchronized host-level and application-level evidence.

It does **not** prove sustained budget sufficiency. See [S01 vs S02](#s01-vs-s02-contract-capture-vs-steady-state-sizing).

### Stack boundary captured

| Subsystem    | How evidence is gathered | Required? |
|--------------|--------------------------|-----------|
| Runtime      | HTTP `GET /health` + `GET /dashboard.json` | ✅ required |
| Notifier     | HTTP `GET /health`       | ✅ required |
| MCP Bridge   | HTTP `GET /health`       | ✅ required |
| Caddy        | Binary path detection + config/data path stat | ✅ required |
| SQLite       | Filesystem stat of DB, WAL, SHM files | ✅ required |
| Logs         | Filesystem stat of known log directories | ✅ required |
| Artifacts    | Filesystem stat of known artifact roots | ✅ required |

---

## Prerequisites

These subsystems must already be running on the CAX11 host before witness capture:

| What          | Expected endpoint / path                              | How to check beforehand                     |
|---------------|-------------------------------------------------------|---------------------------------------------|
| Trader Runtime | `http://127.0.0.1:3001/health` and `/dashboard.json`  | `curl http://127.0.0.1:3001/health`         |
| Upstox Notifier | `http://127.0.0.1:8788/health`                      | `curl http://127.0.0.1:8788/health`         |
| MCP Bridge    | `http://127.0.0.1:8787/health`                        | `curl http://127.0.0.1:8787/health`         |
| Caddy         | Binary at `/usr/bin/caddy` or `/usr/local/bin/caddy`   | `which caddy` or `caddy version`            |
| SQLite DB     | `./data/trader.db` (project relative)                 | `ls -la data/trader.db`                     |
| Log dirs      | `./tmp/upstox/logs`, `./logs`                         | `ls -la tmp/upstox/logs/`                   |
| Artifact root | `./data/artifacts`                                    | `ls -la data/artifacts/`                    |

**Expected startup sequence** (see the [Upstox stack runbook](#cross-references) for details):

```bash
# 1. Start notifier + MCP bridge + tunnel
bash scripts/start-upstox-stack.sh --request-token

# 2. Approve token in Upstox / WhatsApp

# 3. Start runtime
bash scripts/start-upstox-stack.sh --await-token --start-runtime
```

> **Note on Caddy:** The witness detects Caddy by checking for the installed binary
> and stat-ing the config path `/etc/caddy/Caddyfile` and data directory
> `/var/lib/caddy/data`. If Caddy is deployed differently (container, alternate path),
> the witness will report it as unreachable. See [Failure states — Caddy](#caddy-unreachable).

### Environment variable overrides

Every default URL/path can be overridden via environment variables when running
the capture command. This is useful for non-standard deployments:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WITNESS_RUNTIME_HEALTH_URL` | `http://127.0.0.1:3001/health` | Runtime health endpoint |
| `WITNESS_RUNTIME_DASHBOARD_URL` | `http://127.0.0.1:3001/dashboard.json` | Runtime dashboard endpoint |
| `WITNESS_NOTIFIER_HEALTH_URL` | `http://127.0.0.1:8788/health` | Notifier health endpoint |
| `WITNESS_BRIDGE_HEALTH_URL` | `http://127.0.0.1:8787/health` | MCP bridge health endpoint |
| `WITNESS_DB_PATH` | `./data/trader.db` | SQLite database path |
| `WITNESS_HTTP_TIMEOUT_MS` | `10000` | HTTP request timeout in ms |

---

## One command

### Shell wrapper (recommended for operators)

```bash
bash scripts/capture-cax11-witness.sh
```

Add a human-readable label to identify this run later:

```bash
bash scripts/capture-cax11-witness.sh --label="pre-deploy-check-2026-05-17"
```

Dry-run mode (prints what would be captured without writing artifacts):

```bash
bash scripts/capture-cax11-witness.sh --dry-run
```

### Direct Node.js invocation

```bash
node --import tsx src/deployment/witness-main.ts
```

With overrides:

```bash
WITNESS_RUNTIME_HEALTH_URL=http://192.168.1.100:3001/health \
  node --import tsx src/deployment/witness-main.ts --label="remote-check"
```

### NPM script aliases

```bash
npm run witness:capture     # node --import tsx src/deployment/witness-main.ts
npm run witness:capture:sh  # bash scripts/capture-cax11-witness.sh
npm run witness:verify      # bash scripts/verify-m007-s01-witness.sh (CI / dev verification)
```

### Exit codes

| Code | Meaning | Bundle written? |
|------|---------|-----------------|
| 0    | All required evidence captured successfully | ✅ Yes |
| 1    | One or more required subsystems unreachable | ✅ Yes (for analysis) |
| 2    | Fatal error (network, filesystem, etc.)     | ❌ No |

---

## Expected artifacts

Every run produces a timestamped bundle under:

```
data/artifacts/deployment-witness/<runId>/
```

The `runId` is the ISO capture timestamp with `:`, `.` replaced by `-`
(e.g. `2026-05-17T06-30-00-000Z`).

### Bundle layout

```
data/artifacts/deployment-witness/<runId>/
├── manifest.json              # ✅ Required — top-level manifest (contract-validated)
├── host-evidence.json         # OS snapshot (hostname redacted, CPU, memory, uptime)
├── runtime-health.json        # Raw /health response from runtime
├── runtime-dashboard.json     # Raw /dashboard.json response from runtime
├── notifier-health.json       # Raw /health response from notifier
├── bridge-health.json         # Raw /health response from MCP bridge
├── path-witnesses.json        # Filesystem evidence for DB, logs, artifacts
├── subsystems.json            # Compact subsystem inventory summary
└── capture-meta.json          # Run metadata (label, endpoints used, timeout)
```

### manifest.json key structure

```json
{
  "schemaVersion": 1,
  "artifactType": "deployment-witness",
  "capturedAt": "2026-05-17T06:30:00.000Z",
  "runId": "2026-05-17T06-30-00-000Z",
  "label": "pre-deploy-check-2026-05-17",
  "subsystems": [
    { "id": "runtime",     "label": "Trader Runtime",      "reachable": true,  "required": true },
    { "id": "notifier",    "label": "Upstox Notifier",      "reachable": true,  "required": true },
    { "id": "mcp-bridge",  "label": "Local MCP Bridge",     "reachable": true,  "required": true },
    { "id": "caddy",       "label": "Caddy / Basic-Auth Proxy", "reachable": true, "required": true },
    { "id": "sqlite",      "label": "SQLite Database",      "reachable": true,  "required": true },
    { "id": "logs",        "label": "Application Logs",     "reachable": true,  "required": true },
    { "id": "artifacts",   "label": "Deployment Artifacts", "reachable": true,  "required": true }
  ],
  "pathWitnesses": [ /* ... */ ],
  "hostEvidence": { /* hostname, platform, arch, memory, CPU, uptime */ },
  "appEvidence": {
    "capturedAt": "...",
    "verdict": "healthy" | "degraded",
    "subsystemCount": 7,
    "unreachableSubsystems": []
  },
  "annotations": []
}
```

### Reading a bundle

```bash
# Inspect the manifest (quick overview)
python3 -m json.tool data/artifacts/deployment-witness/2026-05-17T06-30-00-000Z/manifest.json

# Check the overall verdict
python3 -c "
import json
m = json.load(open('data/artifacts/deployment-witness/2026-05-17T06-30-00-000Z/manifest.json'))
print('Verdict:', m['appEvidence']['verdict'])
print('Unreachable:', m['appEvidence']['unreachableSubsystems'])
print('Host:', m['hostEvidence']['hostname'])
"

# List all subsystem statuses
python3 -c "
import json
m = json.load(open('data/artifacts/deployment-witness/2026-05-17T06-30-00-000Z/manifest.json'))
for s in m['subsystems']:
    status = '✅' if s['reachable'] else '❌'
    req = '(required)' if s['required'] else '(optional)'
    print(f'{status} {s[\"id\"]}: {s[\"label\"]} {req}')
"

# Check host resources
python3 -c "
import json
m = json.load(open('data/artifacts/deployment-witness/2026-05-17T06-30-00-000Z/manifest.json'))
h = m['hostEvidence']
print(f'CPU: {h[\"cpuCores\"]}x {h[\"cpuModel\"]}')
print(f'Memory: {h[\"totalMemoryBytes\"] / 1024**3:.1f} GB total, {h[\"freeMemoryBytes\"] / 1024**3:.1f} GB free')
print(f'Load 1m: {h[\"loadAverage1m\"]}')
print(f'Uptime: {h[\"hostUptimeSec\"] / 86400:.1f} days')
"
```

---

## Redaction guarantees

The witness never writes raw secrets to disk. The following are redacted before
serialization:

| What | How it's redacted |
|------|-------------------|
| Hostname | First 8 chars + stable 6-char hex hash (e.g. `myhostna-a1b2c3`) |
| Secret-bearing JSON keys | Value masked: `abc...xyz` (first 4 + last 4 chars preserved) |
| Keys matched: `access_token`, `token`, `bearer`, `authorization`, `auth_header`, `cookie`, `session_id`, `api_key`, `apikey`, `secret`, `password`, `basic_auth`, `basic-auth` | Recursive `redactMap()` scans all nested objects and arrays |
| Subsystem metadata | Any metadata field whose key matches the secret patterns above is masked |

**What is NOT redacted** (by design — these are safe for artifact storage):

- CPU model, core count, memory totals
- OS platform / arch / release
- Load average, free memory, uptime
- Whether a path exists, its size, and modification time
- Subsystem reachability status and endpoint URLs
- Run IDs, labels, capture timestamps

---

## Inspecting subsystem evidence

### Runtime

**Evidence files:** `runtime-health.json`, `runtime-dashboard.json`

Look for:
- `verdict: "healthy"` in health response
- `overall` / `verdict` in dashboard response
- `lifecycleState: "running"` in health response
- `executionMode` in dashboard (should be `"blocked"` for blocked-mode deployment)
- `strategyDecisionCount` — number of decisions processed

**What a reachable runtime looks like:**

```json
// runtime-health.json
{ "verdict": "healthy", "uptimeMs": 86400000, "lifecycleState": "running" }

// runtime-dashboard.json
{ "overall": "healthy", "strategyDecisionCount": 42, "executionMode": "blocked" }
```

### Notifier

**Evidence file:** `notifier-health.json`

Look for:
- HTTP 200 response
- `uptimeMs` — how long the notifier has been running
- `lastDelivery` — recent delivery timestamp (confirms the webhook tunnel is alive)

**What a reachable notifier looks like:**

```json
{ "uptimeMs": 86400000, "notifierPath": "/home/pi/trader", "lastDelivery": "2026-05-17T06:29:00.000Z" }
```

### MCP Bridge

**Evidence file:** `bridge-health.json`

Look for:
- HTTP 200 response
- `bridge.token.exists = true` — the access token is loaded
- `bridge.uptimeMs` — bridge runtime
- `bridge.recentCalls` — recent quote/instrument call success
- `lastFailure: null` — no recent failures

**What a reachable bridge looks like:**

```json
{
  "bridge": {
    "uptimeMs": 86400000,
    "token": { "exists": true, "age": 3600 },
    "recentCalls": { "success": 150, "failure": 0 }
  }
}
```

### Caddy

**Evidence file:** `capture-meta.json` (Caddy info lives in manifest `subsystems` metadata)

The witness discovers Caddy by:
1. Checking if the binary exists at `/usr/bin/caddy` or `/usr/local/bin/caddy`
2. Stat-ing the config file `/etc/caddy/Caddyfile`
3. Stat-ing the data directory `/var/lib/caddy/data`

Look in the manifest for:

```json
{
  "id": "caddy",
  "reachable": true,
  "metadata": {
    "caddyInstalled": true,
    "caddyRunning": false,
    "configExists": true,
    "dataExists": true
  }
}
```

> **Note:** `caddyRunning` is currently best-effort. The witness can detect the
> binary and configuration paths but does not actively probe the Caddy HTTP port.
> If Caddy is deployed in a container or at a non-standard path, it will appear
> as unreachable (see [failure states](#caddy-unreachable)).

### SQLite

**Evidence file:** `path-witnesses.json`

The witness stats three files:
- `./data/trader.db` — main database
- `./data/trader.db-wal` — Write-Ahead Log (WAL)
- `./data/trader.db-shm` — Shared Memory file

Look for:

```json
{
  "label": "SQLite database",
  "path": "./data/trader.db",
  "exists": true,
  "sizeBytes": 4194304,
  "mtimeMs": 1747467000000
}
```

A missing DB or WAL file is a **required-evidence failure** (exit code 1).

### Logs

**Evidence file:** `path-witnesses.json`

Two log directories are checked:
- `./tmp/upstox/logs` — notifier/bridge/tunnel/runtime logs
- `./logs` — application logs

Each includes a directory listing (`children` array) when the directory exists.

The `tmp/upstox/logs` directory should contain:
- `notifier.log`
- `bridge.log`
- `tunnel.log`
- `runtime.log`

### Artifacts

**Evidence file:** `path-witnesses.json`

Witnesses the configured artifact root directories plus the deployment-witness
directory itself:

- `./data/artifacts` (with directory listing)
- `./data/artifacts/deployment-witness` (witness bundles accumulate here)

---

## Failure states

### Required evidence unreachable

If the capture completes but one or more required subsystems are unreachable:

1. **Exit code 1** (not 0, not 2)
2. **Bundle is still written** for post-mortem analysis
3. **`appEvidence.verdict`** is `"degraded"` instead of `"healthy"`
4. **`appEvidence.unreachableSubsystems`** lists the IDs of unreachable subsystems

**How to read a degraded bundle:**

```bash
python3 -c "
import json
m = json.load(open('data/artifacts/deployment-witness/<runId>/manifest.json'))
print('Verdict:', m['appEvidence']['verdict'])
print('Unreachable:', m['appEvidence']['unreachableSubsystems'])
for s in m['subsystems']:
    if not s['reachable']:
        print(f'❌ {s[\"id\"]}: {s[\"label\"]}')
        if s['metadata']:
            print(f'   metadata: {json.dumps(s[\"metadata\"], indent=4)}')
"
```

### Caddy unreachable

Caddy can be unreachable for reasons that do not mean the deployment is broken:

| Scenario | Detection | Action |
|----------|-----------|--------|
| Caddy binary at non-standard path | Binary check fails, config stat fails | Set `WITNESS_CADDY_BINARY` / `WITNESS_CADDY_CONFIG` env vars (future) |
| Caddy in Docker container | Binary and paths are inside container, invisible to host | Accept Caddy unreachable, add Docker inspection logic (future work) |
| Caddy not yet deployed | Binary missing, config missing | Caddy is a required subsystem — fix deployment before proceeding |
| Caddy deployed but not running | Binary exists, config exists, process not found | Service may need restart: `sudo systemctl restart caddy` |

**Current limitation:** The witness detects Caddy via filesystem (binary + config + data
directory). It does **not** probe the Caddy HTTP port (typically :443 or :80). If you
need Caddy HTTP-level evidence, that is a candidate for S02 measurement improvement.

### Runtime health/dashboard unreachable

If both `/health` and `/dashboard.json` are unreachable:

1. The runtime subsystem is marked unreachable
2. The bundle verdict is `degraded`
3. The runtime metadata includes the HTTP error(s) for diagnosis

**Check before re-running:**
```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/dashboard.json
```

If the runtime is actually running but on a different port, use `WITNESS_RUNTIME_HEALTH_URL`
and `WITNESS_RUNTIME_DASHBOARD_URL` env vars.

### Fatal error (exit code 2)

Exit code 2 means the capture itself failed — typically:

- Filesystem error creating the bundle directory
- Out of disk space
- Network error that prevented all HTTP fetches from starting

**No bundle is written.** Check:
```bash
df -h .
node --version
```

### False-positive: SQLite missing on first run

If the trader runtime has never been started, `data/trader.db` may not exist.
Start the runtime at least once before running the witness, or use
`WITNESS_DB_PATH` to point to the expected location.

---

## S01 vs S02: contract capture vs steady-state sizing

| Concern | S01 (this runbook) | S02 (planned) |
|---------|--------------------|---------------|
| **What it proves** | The deployment boundary is enumerable and photographable at a point in time | Subsystems stay within budget over sustained operation |
| **Evidence** | Single HTTP snapshot per subsystem + filesystem stat | Time-series metrics, resource usage trends |
| **Duration** | Instant (< 30 seconds) | Minutes to hours |
| **Caddy** | Binary/config existence check | HTTP-level probe, certificate expiry, request latency |
| **SQLite** | File exists, size, mtime | WAL growth rate, query latency, disk IOPS |
| **Failure semantics** | Fail-closed: any missing required evidence → degraded | Fail-closed: budget exceeded → alert |
| **Bundle** | `data/artifacts/deployment-witness/<runId>/` | Same layout but with time-series evidence files |

In short: **S01 proves you can see the whole stack. S02 proves the stack can stay up.**

---

## Cross-references

### Upstox stack runbook

The canonical operational runbook for starting and troubleshooting the Upstox
notifier, MCP bridge, localtunnel, and trader runtime:

📄 `docs/upstox-stack-runbook.md`

Key sections reused here:
- [Fast path startup sequence](docs/upstox-stack-runbook.md#fast-path)
- [Useful direct checks (health endpoints)](docs/upstox-stack-runbook.md#useful-direct-checks)
- [Common failure modes](docs/upstox-stack-runbook.md#common-failure-modes)
- [Local log paths](docs/upstox-stack-runbook.md#local-log-paths)
- [Status / pid paths](docs/upstox-stack-runbook.md#status--pid-paths)

### Systemd service unit

The production deployment unit for the trader runtime:

📄 `config/systemd/trader.service`

Assumptions to be aware of:
- Runs as user `pi` with `WorkingDirectory=/home/pi/trader`
- Database at `./data/production.db` (note: witness defaults to `./data/trader.db`)
- Memory limit: 256M, CPU quota: 50%
- Logs go to journald (`journalctl -u trader.service -f`)
- If the systemd unit uses `trader.db` vs `production.db`, set `WITNESS_DB_PATH` accordingly

### Verification script

Mechanical end-to-end verification of the witness capture pipeline
(for CI or dev environment):

📄 `scripts/verify-m007-s01-witness.sh`

This script starts helper services (notifier, MCP bridge, runtime stub),
runs the witness capture, and validates:
- Bundle directory and manifest existence
- Valid JSON manifest matching the contract schema
- All 7 required subsystem records present
- All 8 evidence files written
- Hostname redaction
- Fail-closed behavior when all evidence is unreachable

### Witness contract (source of truth)

For the canonical type definitions, validation rules, and redaction logic:

📄 `src/deployment/witness-contract.ts`
📄 `src/deployment/witness-capture.ts`
📄 `src/deployment/witness-main.ts`
