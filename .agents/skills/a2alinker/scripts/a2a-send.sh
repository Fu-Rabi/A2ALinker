#!/bin/bash
# A2A Linker — Send Message Script
# Sends a message to the session via HTTP POST and waits for DELIVERED confirmation.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] "message [OVER|STANDBY]"
# Exit 0 = DELIVERED, Exit 1 = NOT_DELIVERED

SERVER="broker.a2alinker.net"
BASE_URL="https://$SERVER"
ROLE="${1:-host}"
MESSAGE="${2:-}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"

if [ -z "$MESSAGE" ]; then
  echo "ERROR: No message provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] \"message [OVER]\""
  exit 1
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Token file not found at $TOKEN_FILE. Run the connect script first."
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")
if [ -z "$TOKEN" ]; then
  echo "ERROR: Token file is empty. Run the connect script first."
  exit 1
fi

RESP=$(curl --max-time 15 -s -w '\n%{http_code}' -X POST "$BASE_URL/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-raw "$MESSAGE")

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q 'DELIVERED'; then
  echo "DELIVERED"
  exit 0
else
  echo "NOT_DELIVERED: $BODY (HTTP $HTTP_CODE)"
  exit 1
fi
