#!/bin/bash
# A2A Linker — Supervisor launcher
# Wraps the Node supervisor and injects A2A_RUNNER_COMMAND if --runner-command
# was not provided explicitly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
REPO_SUPERVISOR_JS="$ROOT_DIR/dist/a2a-supervisor.js"
SKILL_SUPERVISOR_JS="$SCRIPT_DIR/../runtime/a2a-supervisor.js"
DEFAULT_CODEX_RUNNER="bash \"$SCRIPT_DIR/a2a-codex-runner.sh\""

if [ -f "$REPO_SUPERVISOR_JS" ]; then
  SUPERVISOR_JS="$REPO_SUPERVISOR_JS"
elif [ -f "$SKILL_SUPERVISOR_JS" ]; then
  SUPERVISOR_JS="$SKILL_SUPERVISOR_JS"
else
  echo "ERROR: supervisor runtime not found."
  echo "Checked:"
  echo "  - $REPO_SUPERVISOR_JS"
  echo "  - $SKILL_SUPERVISOR_JS"
  exit 1
fi

HAS_RUNNER=false
HAS_SCRIPT_DIR=false
for arg in "$@"; do
  if [ "$arg" = "--runner-command" ]; then
    HAS_RUNNER=true
  fi
  if [ "$arg" = "--script-dir" ]; then
    HAS_SCRIPT_DIR=true
  fi
done

EXTRA_ARGS=()
if [ "$HAS_SCRIPT_DIR" = false ]; then
  EXTRA_ARGS+=(--script-dir "$SCRIPT_DIR")
fi

if [ "$HAS_RUNNER" = false ]; then
  if [ -z "${A2A_RUNNER_COMMAND:-}" ]; then
    if command -v codex >/dev/null 2>&1; then
      exec node "$SUPERVISOR_JS" "$@" "${EXTRA_ARGS[@]}" --runner-command "$DEFAULT_CODEX_RUNNER"
    fi
    echo "ERROR: A2A_RUNNER_COMMAND is not set. Export it, pass --runner-command explicitly, or install codex for the default runner."
    exit 1
  fi
  exec node "$SUPERVISOR_JS" "$@" "${EXTRA_ARGS[@]}" --runner-command "$A2A_RUNNER_COMMAND"
fi

exec node "$SUPERVISOR_JS" "$@" "${EXTRA_ARGS[@]}"
