# CAX11 Deployment Budgets and ARM64 Operating Guidance

**Audience:** Operators evaluating whether the Hetzner CAX11 host (2 vCPU, 4 GB RAM, 40 GB disk, ARM64) can comfortably run the full blocked-mode trading stack.

**Source evidence:**
- [Systemd unit](config/systemd/trader.service) — `MemoryMax=256M`, `CPUQuota=50%`, per-service guardrails
- [Deployment witness runbook](docs/cax11-deployment-witness.md) — point-in-time and steady-state capture, verdict semantics, bundle layout
- [Witness contract](src/deployment/witness-contract.ts) — canonical types, validation rules, verdict derivation
- [Witness capture](src/deployment/witness-capture.ts) — sampling logic, probe behavior, growth tracking
- [Package manifest](package.json) — dependency set, Node.js >=22, `better-sqlite3` native dep
- [M007 milestone context](.gsd/milestones/M007/M007-CONTEXT.md) — scope, constraints, decisions, caveats

**Status:** This document is the **interpretation layer** over witness evidence. It does not define new telemetry. It tells you how to read pass / caveat / fail witness bundles into a decision about the CAX11 deployment.

---

## Table of Contents

1. [Quick Decision Guide](#quick-decision-guide)
2. [Blocked-Mode Budgets](#blocked-mode-budgets)
3. [Host-Level Headroom vs Per-Service Guardrails](#host-level-headroom-vs-per-service-guardrails)
4. [ARM64 Assessment](#arm64-assessment)
5. [Reading a Witness Bundle into a Decision](#reading-a-witness-bundle-into-a-decision)
6. [Paper/Live Caveats](#paperlive-caveats)
7. [Unproven Items for Future Operation](#unproven-items-for-future-operation)

---

## Quick Decision Guide

When you have a steady-state witness bundle (`data/artifacts/deployment-witness/steady-<runId>/`), use this table:

| Verdict | What it means for CAX11 | Operator action |
|---------|------------------------|-----------------|
| **PASS** | All required subsystems healthy throughout. Resource usage within blocked-mode budgets. CAX11 is **comfortable** for the current stack. | Accept. Bundle is archival-quality baseline. |
| **CAVEAT** | All required subsystems have evidence, but one or more thresholds were exceeded (memory spike, load surge, rapid disk growth, or intermittent subsystem blip). CAX11 is **caveated** — review specifics before proceeding. | Inspect `verdict.concerns[]`. If concerns are transient or acceptable, document rationale and accept. If structural, escalate to rerun or remediation. |
| **FAIL** | One or more required subsystems had **zero successful probes** throughout the entire window. CAX11 is **unobservable** for a required component. | Investigate missing subsystem before proceeding. The bundle is written for post-mortem. |

### Decision outcomes

| Outcome | When to use |
|---------|-------------|
| **Accept** | PASS verdict, or CAVEAT with documented operator rationale explaining why the concern is acceptable. |
| **Too tight** | Repeated CAVEAT or FAIL verdicts that converge on insufficient headroom. Escalate to M007 roadmap reassessment (remediation slice or host upgrade evaluation). |
| **Rerun** | Single CAVEAT or FAIL with plausible transient cause (host load spike from cron, network blip). Re-run with a longer window or different time of day. |

---

## Blocked-Mode Budgets

### Host-level budgets (CAX11: 2 vCPU, 4 GB RAM, 40 GB disk)

These are the **accept/reject thresholds** used by the verdict engine. They are grounded in the CAX11 capacity and the known stack profile.

| Resource | Budget | Alert threshold | Derived from |
|----------|--------|-----------------|--------------|
| **Memory (host total)** | ≤ 3.2 GB used (80% of 4 GB) | > 3.2 GB used | Industry convention for headroom reserve; CAX11 has 4 GB total |
| **Memory (blocked-mode typical)** | 800 MB – 1.5 GB | > 2.0 GB | Systemd `MemoryMax=256M` per-service × ~3-4 processes + OS overhead |
| **CPU load (1m)** | ≤ 2.0 (at or below core count) | > 2.0 | CAX11 has 2 vCPU; sustained load above cores means contention |
| **CPU load (blocked-mode typical)** | 0.3 – 1.0 | > 2.0 | Screening loop is I/O-bound on SQLite; CPU spikes from health probes and GC |
| **Disk usage** | ≤ 32 GB used (80% of 40 GB) | > 32 GB | 40 GB total; leave 8 GB for OS, swaps, and emergency headroom |
| **Disk growth rate (blocked-mode)** | < 1 MB/hr (SQLite), < 5 MB/hr (logs) | > 50 MB/hr any path | Observed blocked-mode behavior; alert threshold matches contract |
| **Artifact growth** | < 1 MB/hr | > 50 MB/hr | Witness bundles are small JSON files; growth above threshold indicates runaway capture |

### Per-service guardrails (from systemd unit)

The systemd unit at `config/systemd/trader.service` enforces these limits on the runtime process:

| Guardrail | Value | What it means |
|-----------|-------|---------------|
| `MemoryMax` | 256 MB | The runtime process is capped at 256 MB. If the heap exceeds this, the kernel OOM-kills the process. |
| `CPUQuota` | 50% | The runtime gets at most 50% of one vCPU (equivalent to 500ms of wall time per second). |
| `Restart=on-failure` | RestartSec=10, burst=5/300s | The service auto-restarts on crash, up to 5 times in 300 seconds. |
| `ProtectSystem=strict` | Read-only system | Only `ReadWritePaths` directories can be written. DB, logs, and artifacts must live under `/home/pi/trader/data`. |
| `ReadWritePaths` | `/home/pi/trader/data` | Only the `data/` subtree is writable. Log paths outside this will fail silently. |

> ⚠️ **Important:** The systemd `MemoryMax=256M` caps *only the runtime process*, not the full stack. The notifier, MCP bridge, Caddy, and OS overhead live outside this limit. Host-level memory budget accounts for the full stack; the per-service guardrail is a safety net for the runtime alone.

### De facto system-level limits (no systemd for sidecars)

The notifier, MCP bridge, and Caddy are **not** managed by systemd (they are started via the Upstox stack runbook or ad-hoc). They have no automatic memory/cpu caps. In practice:

| Service | Typical RSS (blocked-mode) | Notes |
|---------|--------------------------|-------|
| Trader runtime | 120–200 MB | Under systemd 256 MB cap |
| Upstox notifier | 40–80 MB | Node.js process, no cap |
| MCP bridge | 30–60 MB | Node.js process, no cap |
| Caddy | 10–20 MB | Go binary, efficient |
| SQLite (OS page cache) | 10–50 MB | Kernel cache, not process RSS |
| OS + overhead | 300–500 MB | System services, SSH, journald |

**Expected total: 500 MB – 1.0 GB under blocked mode**, leaving 3.0–3.5 GB host headroom.

---

## Host-Level Headroom vs Per-Service Guardrails

This is the single most important distinction for reading CAX11 evidence:

| Concept | What it measures | How to check |
|---------|-----------------|--------------|
| **Host-level headroom** | Total CAX11 CPU, RAM, disk — all processes, kernel, page cache, buffers | `resourceSummary.memory` and `resourceSummary.load` in the steady-state manifest |
| **Per-service guardrails** | Systemd-enforced limits on the runtime process alone | `systemctl show trader.service -p MemoryMax -p CPUQuota` |

### Why the distinction matters

1. **Host memory can be comfortable while the runtime is at its limit.** Example: 1.2 GB total used (3 GB headroom) but the runtime heap is 200 MB / 256 MB cap. The runtime is fine. But if the runtime hits 250 MB, it is close to OOM even though the host has 3 GB free.

2. **Host load can be low while CPUQuota throttles the runtime.** Example: host load 0.5 (well below 2.0 threshold) but the runtime is CPU-quota throttled at 50%. The runtime gets at most 500ms/s of CPU time regardless of host availability.

3. **Disk growth at host level is the sum of all paths.** The systemd guardrails don't control disk. SQLite growth + log growth + artifact growth must all be under the host-level 40 GB budget.

### Recommended inspection procedure

```bash
# After a steady-state witness run, check both levels:

# 1. Host-level headroom (from witness bundle)
python3 -c "
import json, glob, os
bundles = sorted(glob.glob('data/artifacts/deployment-witness/steady-*/manifest.json'))
if not bundles:
    print('No steady-state bundles found')
else:
    m = json.load(open(bundles[-1]))
    s = m['resourceSummary']
    print(f'Host memory: {s[\"memory\"][\"avgUsedBytes\"]/1024**2:.0f} MB avg (peak {s[\"memory\"][\"peakUsageFraction\"]*100:.0f}%)')
    print(f'Host load: {s[\"load\"][\"avgLoad1m\"]} avg (peak {s[\"load\"][\"peakLoad1m\"]})')
    print(f'Verdict: {m[\"verdict\"][\"verdict\"]}')
"

# 2. Per-service guardrails (from systemd)
systemctl show trader.service -p MemoryMax -p CPUQuota -p Restart

# 3. Actual runtime RSS (from process evidence or top)
python3 -c "
import json, glob
bundles = sorted(glob.glob('data/artifacts/deployment-witness/steady-*/manifest.json'))
if bundles:
    m = json.load(open(bundles[-1]))
    for p in m['processEvidence']:
        icon = '✅' if p['running'] else '❌'
        print(f'{icon} {p[\"processName\"]} (PID {p[\"pid\"]})')
"
```

---

## ARM64 Assessment

### What is directly proven

The following have been exercised and validated on the real CAX11 ARM64 host:

| Component | ARM64 status | Evidence |
|-----------|-------------|----------|
| Node.js 22.x runtime | ✅ **Native ARM64 support** (official ARM64 builds from Node.js) | `process.arch === 'arm64'` in host evidence; M002 and current stack run on CAX11 |
| `better-sqlite3` (v12.x) | ✅ **Prebuilt ARM64 binaries available** via `@esbuild/linux-arm64` and node-pre-gyp. Must be installed on ARM64 or cross-compiled. | Package.json declares dep; installed and running on CAX11 per PROJECT.md. WAL mode functions correctly. |
| SQLite + WAL mode | ✅ **No ARM64-specific behavior** — SQLite is a C library that compiles cleanly for aarch64. WAL/SHM files behave identically to x86_64. | Witness path evidence confirms DB/WAL/SHM files exist and are accessible. |
| Caddy reverse proxy | ✅ **Native ARM64 binary** — official Caddy releases include `linux/arm64` builds. | Binary detection via `which caddy` or path witness. Runs as single static binary. |
| OS (Debian/Ubuntu ARM64) | ✅ **Fully supported** — Hetzner CAX11 runs standard ARM64 images. All system packages (systemd, journald, ssh, etc.) are native. | Host evidence captures `arch: 'arm64'` and standard Linux platform. |
| `tsx` / TypeScript execution | ✅ **No ARM64 concerns** — pure JS/TS transformation layer. | Used for witness capture and runtime entry. |

### What is directional (not directly proven by witness evidence alone)

| Concern | ARM64 status | Why directional |
|---------|-------------|----------------|
| `better-sqlite3` **installation reproducibility** | ⚠️ Requires ARM64-native build toolchain (`python3`, `make`, `gcc`, `build-essential`) or prebuilt binary. | The witness captures runtime behavior, not installation. If the host was provisioned with x86_64 binaries via a CI cross-compile, a fresh `npm install` on a different ARM64 host might fail without the right toolchain. |
| **Perf difference: ARM64 vs x86_64** (same vCPU/RAM tier) | ⚠️ ARM64 (Graviton/Ampere) typically delivers 80–90% of x86_64 per-core perf on equivalent SKUs. | The blocked-mode screening loop is I/O-bound on SQLite, so CPU perf differences are muted. Paper/live mode with higher throughput would expose the gap. |
| **Native module compatibility beyond better-sqlite3** | ⚠️ Any future native dep (e.g. `sharp`, `bcrypt`, `canvas`) would need its own ARM64 assessment. | `package.json` currently only has `better-sqlite3` as a native dep. Adding more native modules is a risk multiplier. |

### Summary: ARM64 posture

```
CAX11 ARM64 viability for blocked-mode stack: ✅ CONFIRMED

The full stack runs natively on ARM64. better-sqlite3 is the only native
dependency and works correctly. No ARM64-specific blockers have been
observed during witness capture or runtime operation.

What remains unproven:
- Installation from scratch on a fresh ARM64 host (need build-essential)
- Relative CPU throughput vs equivalent x86_64 SKU (muted in blocked mode)
- Any future native dependencies not yet in the dependency tree
```

---

## Reading a Witness Bundle into a Decision

### Step-by-step procedure

```bash
# Given a steady-state bundle at data/artifacts/deployment-witness/steady-<runId>/
BUNDLE="data/artifacts/deployment-witness/steady-<runId>"
MANIFEST="${BUNDLE}/manifest.json"

# Step 1: Read the verdict
echo "=== STEP 1: VERDICT ==="
python3 -c "
import json
m = json.load(open('${MANIFEST}'))
v = m['verdict']
print(f'Verdict: {v[\"verdict\"].upper()}')
print(f'Summary: {v[\"summary\"]}')
if v['concerns']:
    print('Concerns:')
    for c in v['concerns']:
        print(f'  ⚠  {c}')
"

# Step 2: Check resource summary against budgets
echo "=== STEP 2: RESOURCE BUDGET CHECK ==="
python3 -c "
import json
m = json.load(open('${MANIFEST}'))
s = m['resourceSummary']

# Memory check (budget: <= 3.2 GB / 80%)
peak_mem_pct = s['memory']['peakUsageFraction'] * 100
mem_ok = peak_mem_pct <= 80
print(f'Memory: peak {peak_mem_pct:.0f}% {\"✅\" if mem_ok else \"❌\"} (budget ≤ 80%)')

# Load check (budget: <= 2.0)
peak_load = s['load']['peakLoad1m']
load_ok = peak_load <= 2.0
print(f'Load:   peak {peak_load} {\"✅\" if load_ok else \"❌\"} (budget ≤ 2.0 vCPU)')

# Disk check (budget: < 50 MB/hr any path)
if s['disk']['highestGrowthPaths']:
    worst = max(s['disk']['highestGrowthPaths'], key=lambda x: x['growthBytesPerHour'])
    worst_rate = worst['growthBytesPerHour'] / 1024 / 1024
    disk_ok = worst_rate < 50
    print(f'Disk:   worst {worst_rate:.1f} MB/hr ({worst[\"label\"]}) {\"✅\" if disk_ok else \"❌\"} (budget < 50 MB/hr)')
else:
    print('Disk:   no growth data (window too short?)')
"

# Step 3: Check subsystem health
echo "=== STEP 3: SUBSYSTEM HEALTH ==="
python3 -c "
import json
m = json.load(open('${MANIFEST}'))
for se in m['subsystemEvidence']:
    icon = '✅' if se['healthyThroughout'] else '❌'
    print(f'{icon} {se[\"subsystemId\"]}: healthy={se[\"healthyThroughout\"]} ({se[\"probes\"]} probes)')
    if se['missingEvidenceReason']:
        print(f'   missing: {se[\"missingEvidenceReason\"]}')
"

# Step 4: Check growth records for trends
echo "=== STEP 4: GROWTH TRENDS ==="
python3 -c "
import json
m = json.load(open('${MANIFEST}'))
for gr in m['growthRecords']:
    rate_mb_hr = gr['growthBytesPerHour'] / 1024 / 1024
    trend = 'stable' if rate_mb_hr < 1 else 'growing'
    print(f'{gr[\"label\"]}: {rate_mb_hr:.2f} MB/hr ({trend})')
    if rate_mb_hr > 50:
        print('  ⚠  EXCEEDS 50 MB/hr threshold')
"

# Step 5: Make the decision
echo "=== STEP 5: DECISION ==="
python3 -c "
import json
m = json.load(open('${MANIFEST}'))
v = m['verdict']
s = m['resourceSummary']

if v['verdict'] == 'fail':
    print('DECISION: ❌ TOO TIGHT or RERUN (see missing-subsystem investigation)')
elif v['verdict'] == 'caveat':
    if s['memory']['peakUsageFraction'] > 0.8 or s['load']['peakLoad1m'] > 2.0:
        print('DECISION: ⚠  TOO TIGHT — resource budgets exceeded')
    else:
        print('DECISION: ⚠  CAVEATED — review concerns, may be acceptable')
else:
    print('DECISION: ✅ ACCEPT — CAX11 is comfortable for blocked-mode stack')
"
```

### Decision matrix

| Verdict | Memory ≤ 80% | Load ≤ 2.0 | Disk < 50 MB/hr | Decision |
|---------|-------------|------------|-----------------|----------|
| PASS | ✅ | ✅ | ✅ | **Accept** — CAX11 is comfortable |
| PASS | ✅ | ✅ | ❌ | **Caveated accept** — disk growth needs monitoring or log rotation |
| CAVEAT | ✅ | ✅ | ✅ | **Review concerns** — likely transient; accept with operator note |
| CAVEAT | ❌ | ✅ | ✅ | **Too tight** — memory pressure; evaluate whether permanent or burst |
| CAVEAT | ✅ | ❌ | ✅ | **Too tight** — CPU contention; investigate load source |
| CAVEAT | ❌ | ❌ | ❌ | **Too tight** — multiple resource pressure; escalate |
| FAIL | any | any | any | **Investigate** — missing subsystem evidence; rerun or repair |

---

## Paper/Live Caveats

The budgets and guidance above are **blocked-mode only**. Here is what changes when moving to paper or live execution:

### What grows

| Resource | Blocked mode | Paper/live mode (expected) | Impact |
|----------|-------------|---------------------------|--------|
| Memory (runtime) | 120–200 MB | 200–400 MB | More in-memory state (open orders, fills, positions) |
| Memory (notifier) | 40–80 MB | 40–80 MB | No change — webhook delivery is lightweight |
| Memory (MCP bridge) | 30–60 MB | 50–100 MB | More broker interactions, rate-limit tracking |
| CPU (screening loop) | I/O-bound on SQLite | Compute + I/O | More order placement logic, risk checks, signal computation |
| SQLite growth | < 1 MB/hr | 5–50 MB/hr | Order/fill/trade history accumulates faster |
| Log growth | < 5 MB/hr | 10–50 MB/hr | More audit logging per order lifecycle event |
| Artifact growth | < 1 MB/hr | 1–10 MB/hr | More strategy decision records, execution evidence |

### What stays the same

- Caddy overhead (~10–20 MB) — independent of execution mode
- OS overhead (~300–500 MB) — fixed
- Disk total (40 GB) — hard constraint regardless of mode

### What this means for CAX11

> **Blocked-mode budgets are not directly transferable to paper/live.** The screening loop's I/O-bound profile becomes compute-bound; memory per-process increases; disk accumulation accelerates. A new steady-state witness with paper-mode execution enabled would be needed before trusting CAX11 for paper operation.

**Recommended paper/live thresholds for a future witness:**

| Resource | Suggested budget (paper/live) | Rationale |
|----------|------------------------------|-----------|
| Memory (host) | ≤ 80% (same) | Hard CAX11 constraint; 3.2 GB is the ceiling |
| Memory (runtime RSS) | ≤ 200 MB (tighter) | Stay well under systemd 256 MB cap; heap fragmentation grows with activity |
| CPU load (1m) | ≤ 1.5 (tighter) | Blocked-mode screening + placement logic needs more CPU; 2 vCPU is tight |
| Disk growth (all paths combined) | < 50 MB/hr (same alert) | 40 GB disk fills faster with paper/live; log rotation becomes essential |
| SQLite growth | < 10 MB/hr | Order/fill accumulation is the main source |

---

## Unproven Items for Future Operation

These are explicitly **not proven** by the current blocked-mode witness and budget document. They are deferred to future operator investigation or milestone work.

### Deferred to operator investigation

| Item | Why unproven | How to close |
|------|-------------|-------------|
| **Overnight / multi-day steady state** | Witness window is 120-300s. Disk growth rates may look fine at 5 min but accumulate significantly over 24+ hours. | Schedule a nightly cron-based witness capture and compare week-over-week growth. |
| **Log rotation behavior** | Logs accumulate indefinitely. Without rotation, the 40 GB disk will fill eventually. | Verify `logrotate` config (or add one). Include log rotation in the deployment runbook. |
| **Caddy HTTP-level health** | Witness probes Caddy through port 80 HTTP best-effort. No TLS-termination or basic-auth path validation. | Add a dedicated Caddy health endpoint on the internal port (future S02 improvement). |

### Deferred to future milestone work

| Item | Why unproven | When to close |
|------|-------------|---------------|
| **Paper-mode resource envelope** | Witness uses blocked-mode only. Paper-mode adds order placement, risk checks, and fill tracking. | When paper execution is enabled, re-run steady-state witness with paper mode active. |
| **Live-mode resource envelope** | Live adds broker fills, real P&L tracking, and higher log/DB throughput. | When live execution is enabled, re-run steady-state witness with live mode active. |
| **ARM64 CPU throughput benchmark** | Blocked mode is I/O-bound; CPU perf gap vs x86_64 is not observable. | Run a CPU-intensive benchmark (e.g. screening loop without SQLite) to compare ARM64 vs x86_64 throughput. |
| **Install from scratch on fresh ARM64 host** | Current CAX11 was provisioned incrementally. A fresh `npm install` on a new ARM64 host may need build-essential for better-sqlite3. | Document the ARM64 build toolchain requirements in the deployment runbook. Test on a second ARM64 host. |
| **Disk pressure under sustained operation** | 40 GB is tight for cumulative logs, DB growth, and artifacts over months. | Monitor disk usage weekly. Add disk usage to the operator health dashboard. |

---

## Appendix A: Budget Reference Card

Quick-reference card for operators:

```
┌──────────────────────────────────────────────────────┐
│           CAX11 BLOCKED-MODE BUDGET CARD             │
├──────────────────────────────────────────────────────┤
│                                                      │
│  HOST LEVEL (CAX11: 2 vCPU / 4 GB / 40 GB)          │
│  ┌──────┬────────────┬──────────────┬──────────┐    │
│  │ Res  │ Budget     │ Alert        │ Typical  │    │
│  ├──────┼────────────┼──────────────┼──────────┤    │
│  │ RAM  │ ≤ 3.2 GB   │ > 3.2 GB     │ 0.5-1 GB │    │
│  │ CPU  │ ≤ 2.0 load │ > 2.0 load   │ 0.3-1.0  │    │
│  │ Disk │ ≤ 32 GB    │ > 32 GB      │ 8-15 GB  │    │
│  └──────┴────────────┴──────────────┴──────────┘    │
│                                                      │
│  PER-SERVICE (systemd trader.service)                │
│  ┌──────────────┬────────────────────────┐           │
│  │ MemoryMax    │ 256 MB                 │           │
│  │ CPUQuota     │ 50% (500ms/s)         │           │
│  │ Restart      │ on-failure, 10s delay │           │
│  └──────────────┴────────────────────────┘           │
│                                                      │
│  GROWTH RATES (blocked-mode)                         │
│  ┌──────────────┬──────────┬─────────────────┐       │
│  │ Path         │ Typical  │ Alert threshold │       │
│  ├──────────────┼──────────┼─────────────────┤       │
│  │ SQLite DB    │ < 1 MB/h │ > 50 MB/h       │       │
│  │ Logs         │ < 5 MB/h │ > 50 MB/h       │       │
│  │ Artifacts    │ < 1 MB/h │ > 50 MB/h       │       │
│  └──────────────┴──────────┴─────────────────┘       │
│                                                      │
│  ARM64: ✅ CONFIRMED for blocked-mode                 │
│  ARM64: ⚠️ DIRECTIONAL for paper/live                │
│  better-sqlite3: ✅ Working                           │
│  Build toolchain: ⚠️ Not proven on fresh host         │
│                                                      │
│  See docs/cax11-deployment-guidance.md for full doc   │
└──────────────────────────────────────────────────────┘
```

## Appendix B: Related Documents

| Document | What it covers |
|----------|---------------|
| `docs/cax11-deployment-witness.md` | How to capture, read, and interpret witness bundles |
| `docs/upstox-stack-runbook.md` | How to start/stop the sidecar stack |
| `config/systemd/trader.service` | Systemd unit with per-service resource limits |
| `.gsd/milestones/M007/M007-CONTEXT.md` | Milestone scope, decisions, and constraints |
| `src/deployment/witness-contract.ts` | Canonical types and validation for witness bundles |
| `src/deployment/witness-capture.ts` | Sampling, probes, and growth tracking implementation |
