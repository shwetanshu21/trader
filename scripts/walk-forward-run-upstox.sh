#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f ./.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DB_PATH="${TRADER_WALK_FORWARD_DB_PATH:-${OPERATOR_UI_DB_PATH:-${TRADER_DB_PATH:-./data/trader-upstox-static.db}}}"

if printf ' %s ' "$*" | grep -Fq ' --db-path '; then
  npx tsx src/replay/walk-forward-runner-upstox-main.ts "$@"
else
  npx tsx src/replay/walk-forward-runner-upstox-main.ts --db-path "$DB_PATH" "$@"
fi
