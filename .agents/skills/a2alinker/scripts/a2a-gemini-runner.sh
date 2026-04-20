#!/bin/bash
# A2A Linker — Gemini runner for the local supervisor

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_validate_runner_env gemini

cd "$WORKDIR"
gemini -y -p "$(cat "$PROMPT_FILE")" > "$RESPONSE_FILE"
