#!/bin/bash
# A2A Linker — Wait for Message Script
# Long-polls the server and blocks until a message arrives or timeout.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh [host|join]
# Exit 0 = HTTP 200 received, Exit 1 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
ROLE="${1:-host}"
TOKEN_FILE="$(a2a_resolve_token_path "$ROLE")"

a2a_migrate_legacy_token "$ROLE"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Token file not found at $TOKEN_FILE. Run the connect script first."
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")
if [ -z "$TOKEN" ]; then
  echo "ERROR: Token file is empty. Run the connect script first."
  exit 1
fi

RESP=$(curl --max-time 115 -s -w '\n%{http_code}' --no-buffer \
  "$BASE_URL/wait" \
  -H "Authorization: Bearer $TOKEN")

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '^MESSAGE_RECEIVED'; then
  echo "$BODY"
  exit 0
fi

# On timeout or error, auto-ping to give the SKILL actionable context
PING=$(curl --max-time 5 -s -w '\n%{http_code}' \
  "$BASE_URL/ping" \
  -H "Authorization: Bearer $TOKEN")
PING_CODE=$(echo "$PING" | tail -1)
PING_BODY=$(echo "$PING" | sed '$d')

if [ "$PING_CODE" = "400" ]; then
  echo "TIMEOUT_ROOM_CLOSED"
  exit 0
elif [ "$PING_CODE" = "200" ]; then
  LAST_SEEN=$(echo "$PING_BODY" | grep -o '"partner_last_seen_ms":[0-9]*' | grep -o '[0-9]*')
  echo "TIMEOUT_ROOM_ALIVE last_seen_ms=${LAST_SEEN:-0}"
  exit 0
else
  echo "TIMEOUT_PING_FAILED"
  exit 1
fi
