#!/bin/bash
# A2A Linker — Codex runner for the local supervisor
# Reads the supervisor prompt from disk, runs `codex exec` non-interactively,
# and writes the final assistant message back to the supervisor response file.

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

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex executable not found in PATH."
  exit 1
fi

codex exec \
  --full-auto \
  --skip-git-repo-check \
  --color never \
  -C "$WORKDIR" \
  -o "$RESPONSE_FILE" \
  - < "$PROMPT_FILE"
