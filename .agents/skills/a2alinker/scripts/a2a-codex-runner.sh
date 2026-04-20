#!/bin/bash
# A2A Linker — Codex runner for the local supervisor
# Reads the supervisor prompt from disk, runs `codex exec` non-interactively,
# and writes the final assistant message back to the supervisor response file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_validate_runner_env codex

codex exec \
  --skip-git-repo-check \
  --color never \
  -C "$WORKDIR" \
  -o "$RESPONSE_FILE" \
  - < "$PROMPT_FILE"
