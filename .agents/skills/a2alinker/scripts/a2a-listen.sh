#!/bin/bash
# A2A Linker — Listener Setup Script
# Registers with the server and creates a pre-staged room.
# Outputs a listen_ code that HOST will use to connect.
# The redeemer of this code automatically becomes HOST.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-listen.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"

# Clean up stale session from previous run (backgrounded to avoid blocking)
if [ -f /tmp/a2a_join_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_join_token)
  if [ -n "$OLD_TOKEN" ]; then
    (curl -s --max-time 5 -X POST "$BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
  rm -f /tmp/a2a_join_token
fi

HEADLESS="${1:-false}"

# One-shot setup: register + create room in 1 round-trip
RESP=$(curl --max-time 15 -s -X POST "$BASE_URL/setup" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"listener\", \"headless\": $HEADLESS}")

if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
LISTEN_CODE=$(echo "$RESP" | grep -o 'listen_[a-zA-Z0-9]*')

if [ -z "$TOKEN" ] || [ -z "$LISTEN_CODE" ]; then
  ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
  echo "ERROR: ${ERROR:-Failed to create listener room}"
  exit 1
fi

echo "$TOKEN" > /tmp/a2a_join_token
chmod 600 /tmp/a2a_join_token

echo "ROLE: join"
echo "LISTENER_CODE: $LISTEN_CODE"
echo "HEADLESS_SET: $HEADLESS"
echo 'NEXT_STEP: Keep the supervisor running, or run bash .agents/skills/a2alinker/scripts/a2a-loop.sh join to stay attached and receive close notifications.'
exit 0
