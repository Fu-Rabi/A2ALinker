#!/bin/bash
# A2A Linker — Room Ping
# Checks if the current session room is still alive.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-ping.sh [host|join]
# Output: ROOM_ALIVE last_seen_ms=NNN | ROOM_CLOSED | PING_ERROR

SERVER="broker.a2alinker.net"
BASE_URL="https://$SERVER"
ROLE="${1:-join}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "PING_ERROR: No token found at $TOKEN_FILE"
  exit 1
fi

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