#!/bin/bash
# A2A Linker — Listener Setup Script
# Registers with the server and creates a pre-staged room.
# Outputs a listen_ code that HOST will use to connect.
# The redeemer of this code automatically becomes HOST.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-listen.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
TOKEN_FILE="$(a2a_resolve_token_path join)"
a2a_migrate_legacy_token join

# Clean up stale session from previous run (backgrounded to avoid blocking)
if [ -f "$TOKEN_FILE" ]; then
  OLD_TOKEN=$(cat "$TOKEN_FILE")
  if [ -n "$OLD_TOKEN" ]; then
    (curl -s --max-time 5 -X POST "$BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
  rm -f "$TOKEN_FILE"
fi

HEADLESS="${1:-false}"

# One-shot setup: register + create room in 1 round-trip
RESP=$(curl --max-time 15 -s -X POST "$BASE_URL/setup" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"listener\", \"headless\": $HEADLESS}")
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server at $BASE_URL (curl exit $CURL_EXIT)"
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
LISTEN_CODE=$(echo "$RESP" | grep -o 'listen_[a-zA-Z0-9]*')

if [ -z "$TOKEN" ] || [ -z "$LISTEN_CODE" ]; then
  ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
  echo "ERROR: ${ERROR:-Failed to create listener room}"
  exit 1
fi

a2a_write_token "$TOKEN_FILE" "$TOKEN"

echo "ROLE: join"
echo "LISTENER_CODE: $LISTEN_CODE"
echo "HEADLESS_SET: $HEADLESS"
echo 'NEXT_STEP: Keep the supervisor running, or run bash .agents/skills/a2alinker/scripts/a2a-loop.sh join to stay attached and receive close notifications.'
exit 0
