#!/bin/bash
# Example custom runner for local Ollama-based models.
# Copy this file, adjust the model name, and select `custom` during runner setup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_validate_runner_env

cd "$WORKDIR"
ollama run llama3.1 < "$PROMPT_FILE" > "$RESPONSE_FILE"
