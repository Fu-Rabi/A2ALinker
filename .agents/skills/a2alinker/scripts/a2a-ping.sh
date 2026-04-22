#!/bin/bash
# A2A Linker — Room Ping
# Checks if the current session room is still alive.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-ping.sh [host|join]
# Output: ROOM_ALIVE last_seen_ms=NNN | ROOM_CLOSED | PING_ERROR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ROLE="${1:-host}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
BASE_URL="$(a2a_resolve_active_base_url_for_role "$ROLE")"

TOKEN=$(a2a_read_primary_token "$ROLE") || {
  echo "PING_ERROR: No token found at $TOKEN_FILE"
  exit 1
}

RESP=$(curl --max-time 5 -s -w '\n%{http_code}' \
  "$BASE_URL/ping" \
  -H "Authorization: Bearer $TOKEN")

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  LAST_SEEN=$(echo "$BODY" | grep -o '"partner_last_seen_ms":[0-9]*' | grep -o '[0-9]*')
  echo "ROOM_ALIVE last_seen_ms=${LAST_SEEN:-0}"
  exit 0
elif [ "$HTTP_CODE" = "400" ]; then
  echo "ROOM_CLOSED"
  exit 0
else
  echo "PING_ERROR: $BODY (HTTP $HTTP_CODE)"
  exit 1
fi
