# ARM64 Deployment Witness Guidance for the Current Blocked-Mode Stack

**Audience:** Operators interpreting deployment-witness artifacts for the current ARM64 blocked-mode trader stack.

**Important scope note:** M007's original milestone brief targeted a Hetzner CAX11 as the sole acceptance environment. The checked-in witness artifacts reviewed in this repo do **not** prove that target yet. They prove the witness seam and provide direct evidence from a local ARM64 host used during validation. This document is therefore written as a **truthful interpretation guide for the current recorded evidence**, plus a checklist for what still must be captured before M007 can be revalidated as a real-CAX11 milestone.

**Source evidence:**
- [Systemd unit](config/systemd/trader.service) — per-service guardrails for the runtime process
- [Deployment witness runbook](docs/cax11-deployment-witness.md) — capture flow, verdict semantics, bundle layout
- [Witness contract](src/deployment/witness-contract.ts) — canonical types, validation rules, verdict derivation
- [Witness capture](src/deployment/witness-capture.ts) — sampling logic, probe behavior, growth tracking
- [Package manifest](package.json) — dependency set, Node.js >=22, `better-sqlite3` native dep
- [M007 milestone context](.gsd/milestones/M007/M007-CONTEXT.md) — original host target, success criteria, and fail-closed acceptance rules
- Latest reviewed local witness artifact: `data/artifacts/deployment-witness/steady-2026-05-17T07-30-26-444Z/manifest.json`

**Status:** This document is the **interpretation layer** over the currently reviewed witness evidence. It does not create new proof. It tells you how to read pass / caveat / fail witness bundles, what the present ARM64 evidence does show, and what remains unproven for the original Hetzner CAX11 acceptance target.

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

| Verdict | What it means | Operator action |
|---------|----------------|-----------------|
| **PASS** | All required subsystems were healthy throughout and resource usage stayed within the configured thresholds for that observed host. | Accept the bundle as evidence for that exact host/configuration. |
| **CAVEAT** | All required subsystems had evidence, but one or more concerns need review: subsystem unhealthy periods, resource spikes, or rapid growth. | Inspect `verdict.concerns[]`, decide whether the issue is transient, expected, or disqualifying. |
| **FAIL** | One or more required subsystems had no evidence throughout the window. | Investigate the missing subsystem before relying on the bundle. |

### Decision outcomes

| Outcome | When to use |
|---------|-------------|
| **Accept** | PASS verdict, or CAVEAT with a documented rationale that is specific to the observed host and deployment shape. |
| **Too tight** | Repeated CAVEAT or FAIL verdicts caused by sustained pressure or missing required surfaces. |
| **Rerun** | A single CAVEAT or FAIL with a plausible transient cause such as temporary host load or an intentionally missing proxy layer during local verification. |

### Current M007 reality

The latest reviewed steady-state witness in this repo is **not** a passing CAX11 proof bundle. It is a local ARM64 witness with these notable properties:

- Platform/arch: `linux arm64`
- Observed CPU shape: `4` cores
- Observed RAM shape: about `8 GB`
- Verdict: `CAVEAT`
- Main concern: required subsystem `caddy` was not healthy throughout the window

That means the current bundle is useful for validating the witness mechanics and some ARM64 behavior, but it does **not** close M007's original “real Hetzner CAX11 steady-state witness” acceptance bar.

---

## Blocked-Mode Budgets

This section distinguishes between:

1. **Configured runtime guardrails** from `config/systemd/trader.service`
2. **Observed local ARM64 witness values** from the latest reviewed bundle
3. **Original CAX11 target budgets** from the milestone brief, which remain planning thresholds until a real CAX11 witness is captured

### A. Configured runtime guardrails (from systemd)

| Guardrail | Value | What it means |
|-----------|-------|---------------|
| `MemoryMax` | `256 MB` | The runtime process is capped at 256 MB. |
| `CPUQuota` | `50%` | The runtime gets at most half a CPU worth of time under systemd. |
| `Restart=on-failure` | `RestartSec=10`, `burst=5/300s` | Crash recovery is automatic but bounded. |
| `ProtectSystem=strict` | enabled | Writes must stay under approved writable paths. |
| `ReadWritePaths` | `/home/pi/trader/data` | Only the `data/` subtree is writable under this unit. |

These are real configured limits for the runtime service regardless of host branding.

### B. Observed local ARM64 witness values

From `data/artifacts/deployment-witness/steady-2026-05-17T07-30-26-444Z/manifest.json`:

| Metric | Observed value | Interpretation |
|--------|----------------|----------------|
| Host RAM | ~`8 GB` total | This is **not** a 4 GB CAX11-sized machine. |
| CPU cores | `4` | This is **not** a 2 vCPU CAX11-sized machine. |
| Peak memory fraction | `43.3%` | Comfortable on the observed host, but not directly portable to a 4 GB target. |
| Peak load (1m) | `3.0` | Below the observed 4-core host's count, but above a 2-vCPU planning ceiling. |
| Disk growth | `0 MB/hr` in the checked window | Useful as local evidence only; the window was short and synthetic. |
| Verdict | `CAVEAT` | Caddy health failed in the reviewed run. |

### C. Original CAX11 target thresholds from the milestone brief

These remain useful as **planning/acceptance thresholds**, not as proven measurements:

| Resource | Target threshold | Why it matters |
|----------|------------------|----------------|
| Host memory | `≤ 80%` of `4 GB` | Leaves headroom on the original target host. |
| CPU load (1m) | `≤ 2.0` on `2 vCPU` | Keeps the stack from sustained contention on the target box. |
| Disk usage | `≤ 32 GB` of `40 GB` | Reserves recovery room for logs, WAL files, and artifacts. |
| Growth rates | Watch for `MB/hr` drift in DB, logs, artifacts | Short clean runs do not prove long-horizon stability. |

### Budget interpretation rule

Do **not** combine evidence from one host with acceptance claims about another host unless the artifact explicitly proves they are the same environment. A local 4-core / 8 GB ARM64 result can inform the risk conversation, but it cannot be labeled as a confirmed Hetzner CAX11 result.

---

## Host-Level Headroom vs Per-Service Guardrails

This distinction is still the most important operational reading rule:

| Concept | What it measures | How to check |
|---------|------------------|--------------|
| **Host-level headroom** | Total CPU, RAM, and disk for the whole observed machine | `resourceSummary`, `resourceSamples`, growth records |
| **Per-service guardrails** | Limits systemd applies to the runtime process only | `config/systemd/trader.service`, `systemctl show trader.service ...` |

### Why the distinction matters

1. The runtime can remain under `256 MB` while the **host** is still overloaded by sidecars, page cache, or other processes.
2. The host can have spare CPU while the runtime is still throttled by `CPUQuota=50%`.
3. Disk pressure is a whole-stack concern — SQLite, WAL, logs, and witness artifacts all compete for the same volume.

### Current observed mismatch to keep in mind

The latest local witness shows a 4-core / ~8 GB ARM64 host, while the M007 context says the target host is 2 vCPU / 4 GB. That means:

- observed host-level headroom is **host-specific**;
- runtime guardrails are **still real**;
- milestone completion still requires a host-level witness from the intended target environment.

---

## ARM64 Assessment

### What is directly proven by checked-in evidence

| Component | ARM64 status | Evidence |
|-----------|-------------|----------|
| Node.js 22.x runtime | ✅ Confirmed on an ARM64 Linux host | Witness annotations show `linux arm64` and Node `v22.22.2`. |
| `better-sqlite3` runtime behavior | ✅ Confirmed in the current repo/runtime environment | The stack runs with the dependency installed; guidance and code paths assume it is active. |
| SQLite/WAL file handling | ✅ Confirmed as part of the witness seam design | Path witness and growth-record logic handle DB/WAL/SHM files on ARM64. |
| Witness tooling itself | ✅ Confirmed on the observed ARM64 host | Point-in-time and steady-state witness commands run and emit manifests. |

### What is **not** directly proven yet

| Concern | Status | Why it remains unproven |
|---------|--------|-------------------------|
| Hetzner CAX11-specific ARM64 proof | ❌ Not proven | The reviewed artifact is not demonstrably from the target Hetzner CAX11 host. |
| Passing full-stack Caddy/front-door proof on the reviewed host | ❌ Not proven | The latest steady-state bundle reports Caddy unhealthy throughout. |
| Fresh-host install reproducibility | ⚠️ Directional | The checked-in evidence validates runtime behavior, not a clean `npm install` on a blank ARM64 host. |
| Relative throughput vs x86_64 | ⚠️ Directional | No comparative benchmark is captured. |
| Future native deps beyond `better-sqlite3` | ⚠️ Directional | Current evidence only covers the present dependency tree. |

### Truthful ARM64 summary

```text
ARM64 viability for the current blocked-mode stack: CONFIRMED on the observed local ARM64 host.

Hetzner CAX11 viability: NOT YET PROVEN by the checked-in reviewed artifacts.

The current evidence demonstrates that Node 22, the witness tooling, and the
better-sqlite3-backed runtime can operate on ARM64. It does not yet prove the
specific Hetzner CAX11 target host, nor a passing full-stack run with Caddy
healthy throughout.
```

---

## Reading a Witness Bundle into a Decision

### Step 1: Read the verdict

```bash
python3 -c "
import json, glob
paths = sorted(glob.glob('data/artifacts/deployment-witness/steady-*/manifest.json'))
m = json.load(open(paths[-1]))
print('Verdict:', m['verdict']['verdict'])
print('Summary:', m['verdict']['summary'])
for concern in m['verdict']['concerns']:
    print(' -', concern)
"
```

### Step 2: Identify the host you actually measured

```bash
python3 -c "
import json, glob
paths = sorted(glob.glob('data/artifacts/deployment-witness/**/manifest.json', recursive=True))
m = json.load(open(paths[-1]))
h = m.get('hostEvidence') or {}
print('platform:', h.get('platform'))
print('arch:', h.get('arch'))
print('cpu cores:', h.get('cpuCores'))
print('total memory GiB:', round(h.get('totalMemoryBytes', 0) / 1024**3, 2))
print('hostname:', h.get('hostname'))
"
```

If those values do not match the target environment you intend to certify, stop short of making target-host claims.

### Step 3: Check required subsystem health

```bash
python3 -c "
import json, glob
paths = sorted(glob.glob('data/artifacts/deployment-witness/steady-*/manifest.json'))
m = json.load(open(paths[-1]))
for se in m['subsystemEvidence']:
    print(se['subsystemId'], 'healthyThroughout=', se['healthyThroughout'], 'probes=', len(se['probes']))
"
```

For the current reviewed local bundle, `caddy` is the blocking caveat.

### Step 4: Compare observed load to the observed host shape

The witness contract now evaluates load against the **observed CPU core count**, not a hardcoded host assumption. That means the caveat logic remains truthful across Pi-like local hosts and any future Hetzner run.

### Step 5: Make the decision

- **Accept** only for the exact host and deployment shape the bundle proves.
- **Too tight** if the target host shows sustained pressure or persistent subsystem health failures.
- **Rerun** if the bundle is from the wrong host, too short, or missing an intentionally omitted subsystem such as a local Caddy proxy.

---

## Paper/Live Caveats

This guidance remains **blocked-mode only**.

Paper and live execution are **not directly transferable** from these witness results because they change:

- runtime memory pressure,
- order / fill persistence churn,
- broker interaction frequency,
- log volume,
- and likely CPU characteristics.

So even once the target host witness exists, additional paper/live evidence will still be needed before claiming those modes are comfortable.

---

## Unproven Items for Future Operation

### Deferred / not proven yet

| Item | Current status | What closes it |
|------|----------------|----------------|
| Real Hetzner CAX11 steady-state witness | **Not proven** | Capture and review a bundle from the actual target host. |
| Caddy healthy-throughout proof in the reviewed run | **Not proven** | Run with the real front door active and health-probed successfully. |
| Full blocked-mode stack on the target host with measured headroom | **Not proven** | Produce a PASS or justified CAVEAT bundle from the target host. |
| Fresh ARM64 host bootstrap | **Deferred** | Validate a clean install path with required build toolchain for `better-sqlite3`. |
| Long-horizon disk/log growth | **Deferred** | Capture longer windows or scheduled recurring witness runs. |
| Paper/live mode budgets | **Deferred** | Re-run witness under those modes. |

### What milestone validation should require next

Before M007 can move from `needs-attention` to `pass`, the reviewed evidence should include:

1. a witness artifact from the actual intended target host;
2. a truthful host shape that matches the milestone acceptance environment;
3. runtime, notifier, MCP bridge, Caddy, SQLite, logs, and artifact evidence together;
4. a steady-state verdict that is either PASS or a justified CAVEAT with explicit operator rationale;
5. updated milestone validation text that cites that reviewed bundle directly.

For the exact operator procedure that captures the missing target-host proof and brings it back into this repo for revalidation, use `docs/m007-cax11-revalidation-procedure.md`.

---

## Appendix A: Current evidence snapshot

Quick reference for the latest reviewed local steady-state artifact:

```text
Artifact: data/artifacts/deployment-witness/steady-2026-05-17T07-30-26-444Z/manifest.json
Host: linux arm64
CPU: 4 cores
Memory: ~8 GB
Verdict: CAVEAT
Concern: Required subsystem 'caddy' was not healthy throughout the window
Peak memory fraction: 43.3%
Peak load (1m): 3.0
```

This is useful evidence. It is just not the same thing as “Hetzner CAX11 confirmed.”

## Appendix B: Related Documents

| Document | What it covers |
|----------|---------------|
| `docs/cax11-deployment-witness.md` | How to capture, inspect, and interpret witness bundles |
| `docs/upstox-stack-runbook.md` | How the sidecar stack is started and observed |
| `config/systemd/trader.service` | Runtime service guardrails and writable-path assumptions |
| `.gsd/milestones/M007/M007-CONTEXT.md` | Original target-host acceptance contract for the milestone |
| `src/deployment/witness-contract.ts` | Canonical witness schemas and verdict derivation |
| `src/deployment/witness-capture.ts` | Sampling, probes, and bundle-writing implementation |
