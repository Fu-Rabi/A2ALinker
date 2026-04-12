#!/bin/bash
# A2A Linker — Claude runner for the local supervisor

set -euo pipefail

PROMPT_FILE="${A2A_SUPERVISOR_PROMPT_FILE:-}"
RESPONSE_FILE="${A2A_SUPERVISOR_RESPONSE_FILE:-}"
WORKDIR="${A2A_SUPERVISOR_WORKDIR:-$PWD}"

if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: A2A_SUPERVISOR_PROMPT_FILE is missing or unreadable."
  exit 1
fi

if [ -z "$RESPONSE_FILE" ]; then
  echo "ERROR: A2A_SUPERVISOR_RESPONSE_FILE is not set."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude executable not found in PATH."
  exit 1
fi

cd "$WORKDIR"
claude -p "$(cat "$PROMPT_FILE")" --dangerously-skip-permissions > "$RESPONSE_FILE"
