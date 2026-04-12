#!/bin/bash
# Example custom runner for local Ollama-based models.
# Copy this file, adjust the model name, and select `custom` during runner setup.

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

cd "$WORKDIR"
ollama run llama3.1 < "$PROMPT_FILE" > "$RESPONSE_FILE"
