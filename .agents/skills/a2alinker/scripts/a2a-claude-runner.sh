#!/bin/bash
# A2A Linker — Claude runner for the local supervisor

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_validate_runner_env claude

cd "$WORKDIR"
claude -p "$(cat "$PROMPT_FILE")" --dangerously-skip-permissions > "$RESPONSE_FILE"
