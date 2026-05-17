#!/usr/bin/env python3
"""
Verify the deployment guidance document (M007/S03/T01).

Structural checks:
1. Guidance document exists and is non-empty
2. Cites steady-state manifest/runbook/systemd sources
3. Includes blocked-mode budgets (CPU, RAM, disk)
4. Includes ARM64 guidance
5. Includes per-service guardrails
6. Explains host-level headroom vs per-service guardrails
7. Documents paper/live caveats
8. Provides operator decision matrix
9. Documents what remains unproven

Truthfulness checks:
10. Guidance does not claim Hetzner/CAX11 proof unless a reviewed witness artifact shows it
11. Guidance aligns host-shape statements with the latest local witness artifact when present
12. Guidance treats ARM64 host evidence as host-specific unless the artifact proves the named target host
"""

import glob
import json
import os
import re
import sys
from typing import Optional

DOC_PATH = "docs/cax11-deployment-guidance.md"
EXPECTED_SOURCES = [
    "config/systemd/trader.service",
    "docs/cax11-deployment-witness.md",
    "src/deployment/witness-contract.ts",
    "src/deployment/witness-capture.ts",
    "package.json",
    ".gsd/milestones/M007/M007-CONTEXT.md",
]

EXPECTED_SECTIONS = [
    "Blocked-Mode Budgets",
    "Host-Level Headroom vs Per-Service Guardrails",
    "ARM64 Assessment",
    "Quick Decision Guide",
    "Paper/Live Caveats",
    "Unproven Items for Future Operation",
]

EXPECTED_BUDGET_TERMS = [
    "Memory",
    "CPU",
    "Disk",
    "256 MB",
    "50%",
    "80%",
    "MB/hr",
]

EXPECTED_ARM64_TERMS = [
    "ARM64",
    "better-sqlite3",
]

EXPECTED_DECISION_TERMS = [
    "PASS",
    "CAVEAT",
    "FAIL",
    "Accept",
    "Too tight",
    "Rerun",
]

EXPECTED_CAVEAT_TERMS = [
    "blocked-mode only",
    "paper",
    "live",
    "not directly transferable",
]

EXPECTED_UNPROVEN_TERMS = [
    "unproven",
    "not proven",
    "Deferred",
]


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  ✅ {message}")
    else:
        print(f"  ❌ {message}")
        global failures
        failures += 1


def read_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""
    except Exception as e:
        print(f"  ⚠  Could not read {path}: {e}")
        return ""


def load_latest_witness() -> Optional[dict]:
    candidates = sorted(glob.glob("data/artifacts/deployment-witness/**/manifest.json", recursive=True))
    if not candidates:
        return None
    latest = candidates[-1]
    try:
        with open(latest, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["__path"] = latest
        return data
    except Exception as e:
        print(f"  ⚠  Could not read witness artifact {latest}: {e}")
        return None


def main():
    global failures
    failures = 0

    print(f"\n{'='*60}")
    print("Verification: M007/S03/T01 — Deployment Guidance Document")
    print(f"{'='*60}")

    content = read_file(DOC_PATH)
    witness = load_latest_witness()

    print("\n[1] Document existence and content")
    check(len(content) > 0, f"{DOC_PATH} exists and is non-empty")
    check(len(content) > 8000, f"{DOC_PATH} has substantial content ({len(content)} chars)")

    print("\n[2] Source artifact citations")
    for src in EXPECTED_SOURCES:
        check(src in content or src.replace("-", "_") in content, f"Cites source: {src}")

    print("\n[3] Required sections")
    for section in EXPECTED_SECTIONS:
        check(section in content, f"Contains section: {section}")

    print("\n[4] Blocked-mode budgets")
    for term in EXPECTED_BUDGET_TERMS:
        check(term in content, f"Budget contains term: {term}")

    print("\n[5] ARM64 guidance")
    for term in EXPECTED_ARM64_TERMS:
        check(term.lower() in content.lower(), f"ARM64 contains term: {term}")

    print("\n[6] Host-level vs per-service distinction")
    check("host-level" in content.lower(), "Explains host-level headroom")
    check("per-service" in content.lower(), "Explains per-service guardrails")
    check("systemd" in content, "References systemd guardrails")

    print("\n[7] Decision guidance")
    for term in EXPECTED_DECISION_TERMS:
        check(term in content, f"Decision guidance contains: {term}")

    print("\n[8] Paper/live caveats")
    for term in EXPECTED_CAVEAT_TERMS:
        check(term.lower() in content.lower(), f"Caveats mention: {term}")

    print("\n[9] Unproven / deferred items")
    for term in EXPECTED_UNPROVEN_TERMS:
        check(term.lower() in content.lower(), f"Unproven contains: {term}")

    print("\n[10] Scope documentation")
    check("blocked-mode" in content.lower(), "Documents blocked-mode scope")
    check("ARM64" in content, "References ARM64 host scope")

    print("\n[11] Truthfulness against local witness evidence")
    check(witness is not None, "Latest local witness artifact is available for comparison")
    if witness is not None:
        witness_path = witness.get("__path", "<unknown>")
        print(f"  ℹ️  Comparing against: {witness_path}")

        host = witness.get("hostEvidence", {})
        total_mem = host.get("totalMemoryBytes")
        cpu_cores = host.get("cpuCores")
        platform = host.get("platform")
        arch = host.get("arch")
        hostname = host.get("hostname", "")

        if total_mem:
            approx_gb = round(total_mem / (1024 ** 3))
            check(str(approx_gb) in content or f"{approx_gb} GB" in content,
                  f"Guidance mentions observed host memory shape (~{approx_gb} GB)")
        if cpu_cores:
            check(f"{cpu_cores} cores" in content or f"{cpu_cores} vCPU" in content or f"{cpu_cores} CPU" in content,
                  f"Guidance mentions observed CPU shape ({cpu_cores} cores)")
        if arch:
            check(arch.lower() in content.lower(), f"Guidance matches observed architecture ({arch})")
        if platform:
            check(platform.lower() in content.lower(), f"Guidance matches observed platform ({platform})")

        caddy_claimed_confirmed = "caddy reverse proxy | ✅" in content.lower() or "caddy reverse proxy | ✅ **native" in content.lower()
        verdict = witness.get("verdict", {}).get("verdict")
        subsystem_evidence = witness.get("subsystemEvidence", [])
        caddy_probe = next((s for s in subsystem_evidence if s.get("subsystemId") == "caddy"), None)
        caddy_healthy = caddy_probe.get("healthyThroughout") if caddy_probe else None
        check(not (caddy_claimed_confirmed and caddy_healthy is False),
              "Guidance does not over-claim Caddy proof when latest witness shows it unhealthy")

        claims_cax11_confirmed = "cax11 arm64 viability for blocked-mode stack: ✅ confirmed" in content.lower()
        looks_like_rpi = hostname.startswith("rspi") or (cpu_cores == 4 and total_mem and total_mem > 6 * 1024 ** 3)
        check(not (claims_cax11_confirmed and looks_like_rpi),
              "Guidance does not label Raspberry Pi-shaped local evidence as confirmed CAX11 proof")

    print(f"\n{'='*60}")
    if failures == 0:
        print("✅ ALL CHECKS PASSED")
        sys.exit(0)
    else:
        print(f"❌ {failures} CHECK(S) FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
