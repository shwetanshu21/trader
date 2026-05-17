#!/usr/bin/env python3
"""
Verify the CAX11 deployment guidance document (M007/S03/T01).

Checks:
1. Guidance document exists and is non-empty
2. Cites steady-state manifest/runbook/systemd sources
3. Includes blocked-mode budgets (CPU, RAM, disk)
4. Includes ARM64 guidance
5. Includes per-service guardrails
6. Explains host-level headroom vs per-service guardrails
7. Documents paper/live caveats
8. Provides operator decision matrix
9. Documents what remains unproven
"""

import os
import sys
import re

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
    "vCPU",
    "4 GB",
    "40 GB",
    "256 MB",
    "50%",
    "80%",
    "MB/hr",
]

EXPECTED_ARM64_TERMS = [
    "ARM64",
    "better-sqlite3",
    "confirmed",
    "directional",
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
    """Assert a check condition, printing pass/fail."""
    if condition:
        print(f"  ✅ {message}")
    else:
        print(f"  ❌ {message}")
        global failures
        failures += 1


def read_file(path: str) -> str:
    """Read a text file, returning content or empty string on error."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""
    except Exception as e:
        print(f"  ⚠  Could not read {path}: {e}")
        return ""


def check_section_exists(content: str, section_name: str) -> bool:
    """Check if a markdown section heading exists."""
    # Match ## or ### heading with the section name
    pattern = rf'^#{{2,3}}\s+{re.escape(section_name)}\s*$'
    return bool(re.search(pattern, content, re.MULTILINE))


def main():
    global failures
    failures = 0

    print(f"\n{'='*60}")
    print(f"Verification: M007/S03/T01 — CAX11 Deployment Guidance Document")
    print(f"{'='*60}")

    # 1. Document exists and is non-empty
    print("\n[1] Document existence and content")
    content = read_file(DOC_PATH)
    check(len(content) > 0, f"{DOC_PATH} exists and is non-empty")
    check(len(content) > 10000, f"{DOC_PATH} has substantial content ({len(content)} chars)")

    # 2. Cites source artifacts
    print("\n[2] Source artifact citations")
    for src in EXPECTED_SOURCES:
        check(src.replace("/", "/") in content or src.replace("-", "_") in content,
              f"Cites source: {src}")

    # 3. Required sections present
    print("\n[3] Required sections")
    for section in EXPECTED_SECTIONS:
        check(section in content, f"Contains section: {section}")

    # 4. Budget content
    print("\n[4] Blocked-mode budgets")
    for term in EXPECTED_BUDGET_TERMS:
        check(term in content, f"Budget contains term: {term}")

    # 5. ARM64 guidance
    print("\n[5] ARM64 guidance")
    for term in EXPECTED_ARM64_TERMS:
        check(term.lower() in content.lower(), f"ARM64 contains term: {term}")

    # 6. Host-level vs per-service distinction
    print("\n[6] Host-level vs per-service distinction")
    check("Host-Level Headroom" in content or "host-level" in content.lower(),
          "Explains host-level headroom")
    check("Per-Service Guardrails" in content or "per-service" in content.lower(),
          "Explains per-service guardrails")
    check("systemd" in content, "References systemd guardrails")

    # 7. Decision matrix
    print("\n[7] Decision guidance")
    for term in EXPECTED_DECISION_TERMS:
        check(term in content, f"Decision guidance contains: {term}")

    # 8. Paper/live caveats
    print("\n[8] Paper/live caveats")
    for term in EXPECTED_CAVEAT_TERMS:
        check(term.lower() in content.lower(), f"Caveats mention: {term}")

    # 9. Unproven items
    print("\n[9] Unproven / deferred items")
    for term in EXPECTED_UNPROVEN_TERMS:
        check(term.lower() in content.lower(), f"Unproven contains: {term}")

    # 10. Blocked-mode scope
    print("\n[10] Scope documentation")
    check("blocked-mode" in content.lower(), "Documents blocked-mode scope")
    check("CAX11" in content, "References CAX11 host")

    # Summary
    print(f"\n{'='*60}")
    if failures == 0:
        print(f"✅ ALL CHECKS PASSED")
        sys.exit(0)
    else:
        print(f"❌ {failures} CHECK(S) FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
