#!/bin/bash
# A2A Linker — Set Headless Room Rule
# Sets the autonomous mode room rule. When headless=true, agents will never
# prompt the user for input during the session.
# The partner agent will be notified automatically on their next /join.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-set-headless.sh [host|join] [true|false]

SERVER="${A2A_SERVER:-broker.a2alinker.net}"
BASE_URL="https://$SERVER"
ROLE="${1:-host}"
HEADLESS="${2:-false}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "ERROR: No token found at $TOKEN_FILE"
  exit 1
fi

RESP=$(curl --max-time 10 -s -X POST "$BASE_URL/room-rule/headless" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"headless\": $HEADLESS}")

if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
  exit 1
fi

if echo "$RESP" | grep -q '"error"'; then
  ERROR=$(echo "$RESP" | sed 's/.*"error":"\([^"]*\)".*/\1/')
  if [ "$ERROR" = "Unauthorized" ]; then
    echo "ERROR: Token expired or server restarted. Clearing $TOKEN_FILE."
    rm -f "$TOKEN_FILE"
  else
    echo "ERROR: $ERROR"
  fi
  exit 1
fi

echo "HEADLESS_SET: $HEADLESS"
exit 0
