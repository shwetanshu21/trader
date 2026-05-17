# M007 CAX11 Target-Host Witness Capture and Revalidation Procedure

**Audience:** The operator or engineer who has shell access to the real Hetzner CAX11 host and needs to produce the exact evidence required to move M007 from `needs-attention` to a fresh validation pass.

**Post-read action:** Capture a reviewed steady-state witness from the real CAX11 host, bring the artifact back into this repo, and rerun milestone validation with truthful pass / caveat / fail reasoning.

**Why this exists:** The checked-in witness tooling and guidance are working, but the current reviewed artifact is still a local ARM64 bundle with a `caddy` caveat. M007 cannot pass until the repo contains a reviewed witness from the actual target host.

---

## 1. What counts as success

This procedure succeeds only if all of the following are true:

1. The witness bundle comes from the real Hetzner CAX11 target host.
2. The bundle covers the blocked-mode full stack: runtime, notifier, local MCP bridge, Caddy/basic auth, SQLite, logs, and artifacts.
3. The steady-state bundle is long enough to show real host behavior, not just startup.
4. The reviewed bundle is checked into `data/artifacts/deployment-witness/steady-<runId>/manifest.json`.
5. The milestone validation text is updated to cite that exact artifact and explain any remaining caveats truthfully.

If any of those are missing, M007 should remain `needs-attention`.

---

## 2. Before you start

You need:

- SSH access to the real Hetzner CAX11 host
- the trader repo checked out on that host
- the blocked-mode deployment already runnable on that host
- a recent Node 22 runtime available on the host
- permission to inspect systemd and local logs

This procedure assumes the runtime is started by the production unit and that the runtime database path follows the systemd unit:

- runtime port: `3000`
- database path: `./data/production.db`

That matters because some earlier docs and local verification flows used `3001` and `./data/trader.db`. For real-host proof, use the production shape, not the local-dev one.

---

## 3. Target-host preflight checks

Run these on the CAX11 host from the repo root.

### 3.1 Confirm host identity

```bash
uname -a
nproc
free -h
df -h .
hostname
```

You are looking for a real Hetzner ARM64 host with the expected CAX11-sized envelope. The exact values will be recorded by the witness bundle, but do not proceed if you are on a local board, laptop, or non-target VM.

### 3.2 Confirm runtime service assumptions

```bash
systemctl status trader.service --no-pager
systemctl show trader.service --property=WorkingDirectory,ExecStart,Environment,MemoryMax,CPUQuota --no-pager
```

Verify:

- `WorkingDirectory=/home/pi/trader` or the intended production checkout path
- runtime is running under systemd
- `TRADER_DB_PATH=./data/production.db`
- runtime guardrails still match the intended production contract

### 3.3 Confirm direct health endpoints

Use the production runtime port from the systemd unit.

```bash
curl -sf http://127.0.0.1:3000/health | python3 -m json.tool
curl -sf http://127.0.0.1:3000/dashboard.json | python3 -m json.tool
curl -sf http://127.0.0.1:8788/health | python3 -m json.tool
curl -sf http://127.0.0.1:8787/health | python3 -m json.tool
```

If any of these fail, do not capture the final witness yet. Fix the stack first.

### 3.4 Confirm Caddy is actually observable

```bash
which caddy || true
caddy version || true
systemctl status caddy --no-pager || true
curl -I http://127.0.0.1/ || true
curl -sf http://127.0.0.1:80/health || true
```

This is the current likely blocker. The last reviewed artifact failed because `caddy` was unhealthy throughout the window.

For M007 to pass cleanly, you want one of these to be true:

- `http://127.0.0.1:80/health` returns success during the witness window, or
- you have a truthful, reviewable reason why a `CAVEAT` verdict still proves the real host is acceptable.

If Caddy is running on a different internal port or only exposes HTTPS, decide that before capture time. Do not hand-wave it later in validation.

### 3.5 Confirm production DB and log/artifact paths

```bash
ls -lah data/production.db data/production.db-wal data/production.db-shm 2>/dev/null || true
ls -lah tmp/upstox/logs || true
ls -lah data/artifacts || true
```

If the DB path is different on the host, note it now. You will need to override `WITNESS_DB_PATH` when capturing.

---

## 4. Optional dry run

Do this once before the real capture so you can spot path/port mistakes without claiming success.

```bash
WITNESS_RUNTIME_HEALTH_URL=http://127.0.0.1:3000/health \
WITNESS_RUNTIME_DASHBOARD_URL=http://127.0.0.1:3000/dashboard.json \
WITNESS_DB_PATH=./data/production.db \
bash scripts/capture-cax11-witness.sh --dry-run --steady-state --duration-sec=120 --interval-sec=30 --label=M007-cax11-preflight
```

If the printed command still points at the wrong runtime port or wrong DB path, stop and fix the overrides before doing the real run.

---

## 5. Real witness capture on the CAX11 host

Run this from the repo root on the target host.

```bash
WITNESS_RUNTIME_HEALTH_URL=http://127.0.0.1:3000/health \
WITNESS_RUNTIME_DASHBOARD_URL=http://127.0.0.1:3000/dashboard.json \
WITNESS_DB_PATH=./data/production.db \
bash scripts/capture-cax11-witness.sh \
  --steady-state \
  --duration-sec=300 \
  --interval-sec=30 \
  --label=M007-cax11-steady-state
```

Notes:

- Use at least a 5 minute window for the target-host proof. The earlier reviewed local artifact was only 30 seconds and too close to startup behavior.
- Keep the full stack running normally during the window.
- Do not restart services in the middle of the capture unless you are explicitly abandoning that run.

### Exit-code handling

- `0`: bundle written with steady-state verdict `pass` or `caveat`
- `1`: bundle written with steady-state verdict `fail`
- `2`: fatal capture error; no usable bundle

A `0` exit code is **not automatically enough**. You still need to inspect the bundle.

---

## 6. Immediate post-capture checks on the host

Find the latest steady-state bundle:

```bash
LATEST="$(ls -td data/artifacts/deployment-witness/steady-*/ | head -1)"
echo "$LATEST"
```

### 6.1 Read the verdict and concerns

```bash
python3 - <<'PY'
import json, os
latest = os.popen("ls -td data/artifacts/deployment-witness/steady-*/ | head -1").read().strip()
with open(f"{latest}/manifest.json", "r", encoding="utf-8") as f:
    m = json.load(f)
print("verdict:", m["verdict"]["verdict"])
print("summary:", m["verdict"]["summary"])
print("reasoning:", m["verdict"]["reasoning"])
print("concerns:")
for c in m["verdict"].get("concerns", []):
    print(" -", c)
PY
```

### 6.2 Confirm the host shape in the artifact

```bash
python3 - <<'PY'
import json, os
latest = os.popen("ls -td data/artifacts/deployment-witness/steady-*/ | head -1").read().strip()
with open(f"{latest}/manifest.json", "r", encoding="utf-8") as f:
    m = json.load(f)
s = m["resourceSamples"][0]
print("platform:", next((a["value"] for a in m.get("annotations", []) if a.get("label") == "capture-platform"), "<missing>"))
print("cpu cores:", s.get("cpuCores"))
print("memory GiB:", round(s.get("totalMemoryBytes", 0) / 1024**3, 2))
PY
```

If the host shape still looks like the old local 4-core / ~8 GB artifact, you captured on the wrong machine or copied the wrong bundle.

### 6.3 Confirm subsystem health throughout

```bash
python3 - <<'PY'
import json, os
latest = os.popen("ls -td data/artifacts/deployment-witness/steady-*/ | head -1").read().strip()
with open(f"{latest}/manifest.json", "r", encoding="utf-8") as f:
    m = json.load(f)
for se in m["subsystemEvidence"]:
    print(se["subsystemId"], "healthyThroughout=", se["healthyThroughout"], "probes=", len(se.get("probes", [])))
PY
```

You want `runtime`, `notifier`, `mcp-bridge`, and `caddy` to all be healthy throughout if possible.

### 6.4 Check resource summary

```bash
python3 - <<'PY'
import json, os
latest = os.popen("ls -td data/artifacts/deployment-witness/steady-*/ | head -1").read().strip()
with open(f"{latest}/manifest.json", "r", encoding="utf-8") as f:
    m = json.load(f)
rs = m["resourceSummary"]
print("sampleCount:", rs["sampleCount"])
print("peakMemoryFraction:", rs["memory"]["peakUsageFraction"])
print("peakLoad1m:", rs["load"]["peakLoad1m"])
print("totalGrowthBytes:", rs["disk"]["totalGrowthBytes"])
PY
```

---

## 7. Decision rules for whether to keep or discard the run

### Keep the run for milestone revalidation when:

- the artifact is clearly from the real CAX11 host
- the steady-state window is long enough to be representative
- runtime, notifier, bridge, and persistence evidence are all present
- the verdict is `pass`, or `caveat` with a specific, defensible rationale

### Discard and rerun when:

- you captured on the wrong host
- the runtime port/DB path was wrong
- the bundle is obviously startup-only or too short
- Caddy failed because of an avoidable observability/config mistake
- the window was disturbed by manual restarts or unrelated host maintenance

### Treat as real blocker when:

- the actual target host shows sustained resource pressure
- `caddy` cannot be kept healthy throughout despite a real deployed front door
- SQLite/log/artifact growth is materially unsafe
- a required subsystem repeatedly produces `fail` or unacceptable `caveat` results

---

## 8. Copy the reviewed artifact back into the repo

From your local machine, copy the reviewed bundle directory from the host into this repo under `data/artifacts/deployment-witness/`.

Example:

```bash
scp -r pi@<cax11-host>:/home/pi/trader/data/artifacts/deployment-witness/steady-<runId> ./data/artifacts/deployment-witness/
```

Then confirm the copied artifact exists locally:

```bash
find data/artifacts/deployment-witness/steady-<runId> -maxdepth 1 -type f | sort
```

Required local file:

- `data/artifacts/deployment-witness/steady-<runId>/manifest.json`

---

## 9. Repo-side revalidation procedure

Once the reviewed target-host artifact is present locally, run these from the repo root.

### 9.1 Recheck the guidance verifier

```bash
python3 scripts/verify-m007-s03-guidance.py
npm run verify:guidance
```

These should still pass. They prove the interpretation layer remains truthful.

### 9.2 Refresh the milestone validation doc

Update `.gsd/milestones/M007/M007-VALIDATION.md` so it cites the new reviewed target-host artifact instead of `steady-2026-05-17T07-30-26-444Z`.

Specifically update:

- Success Criteria Checklist
- Requirement Coverage
- Verification Class Compliance
- Verdict Rationale

The new text must explicitly say one of:

- **pass**: real CAX11 proof now exists and all prior blockers are retired, or
- **needs-attention**: target-host proof exists but remaining caveats still block closure, or
- **needs-remediation**: the target host proved inadequate or unstable and remediation slices are needed

Do not leave the validation doc pointing at the old local ARM64 witness once a real reviewed target-host artifact is available.

### 9.3 Rerun milestone validation

After the validation document is updated truthfully, save the new verdict with the milestone validator.

Use:

- `pass` only if the target-host artifact closes the operational blocker
- `needs-attention` if the artifact is real but still caveated in a way that blocks completion
- `needs-remediation` if the evidence shows the host/deployment needs changes before M007 can close

---

## 10. What the final validation should say

A passing revalidation should be able to say all of this truthfully:

- the reviewed artifact is from the real Hetzner CAX11 host
- the full blocked-mode operator-facing stack was measured together
- CPU, RAM, and disk headroom were observed directly on that host
- ARM64 compatibility is proven for the current blocked-mode runtime shape on that host
- any remaining caveats are documented and are not milestone blockers

If you cannot say those things truthfully, do not force `pass`.

---

## 11. Minimal evidence bundle to attach to the revalidation decision

Bring back or cite at least:

1. `data/artifacts/deployment-witness/steady-<runId>/manifest.json`
2. the exact capture command used
3. the runtime port and DB path used during capture
4. whether Caddy was healthy throughout
5. the final verdict and concerns list
6. peak memory fraction, peak load, and disk growth summary

That is the minimum evidence set needed for a credible M007 revalidation.

---

## 12. If Caddy is still the only blocker

If the real target-host run is otherwise good but `caddy` remains the only concern, decide explicitly between these two paths:

### Path A — fix observability and rerun

Use this if Caddy is actually healthy but the witness cannot see it because of port/path assumptions.

### Path B — accept a justified caveat

Use this only if:

- the target host is unquestionably the real CAX11
- the full stack is otherwise healthy
- you can explain why the Caddy concern is observational rather than operational
- the validation text preserves that nuance without claiming a clean pass on something unproven

If that rationale feels weak, rerun after fixing observability instead.

---

## 13. Quick command checklist

On the CAX11 host:

```bash
systemctl status trader.service --no-pager
systemctl show trader.service --property=WorkingDirectory,ExecStart,Environment,MemoryMax,CPUQuota --no-pager
curl -sf http://127.0.0.1:3000/health | python3 -m json.tool
curl -sf http://127.0.0.1:3000/dashboard.json | python3 -m json.tool
curl -sf http://127.0.0.1:8788/health | python3 -m json.tool
curl -sf http://127.0.0.1:8787/health | python3 -m json.tool
curl -sf http://127.0.0.1:80/health || true
WITNESS_RUNTIME_HEALTH_URL=http://127.0.0.1:3000/health \
WITNESS_RUNTIME_DASHBOARD_URL=http://127.0.0.1:3000/dashboard.json \
WITNESS_DB_PATH=./data/production.db \
bash scripts/capture-cax11-witness.sh --steady-state --duration-sec=300 --interval-sec=30 --label=M007-cax11-steady-state
```

Back in the repo:

```bash
python3 scripts/verify-m007-s03-guidance.py
npm run verify:guidance
```

Then update milestone validation against the copied reviewed artifact.
