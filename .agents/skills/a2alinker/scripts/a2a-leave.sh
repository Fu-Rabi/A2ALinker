#!/bin/bash
# A2A Linker — Leave Session Script
# Cleanly disconnects the current agent from the relay room.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-leave.sh [host|join]

SERVER="${A2A_SERVER:-broker.a2alinker.net}"
BASE_URL="https://$SERVER"
ROLE="${1:-host}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "LEAVE_ERROR: No token found at $TOKEN_FILE"
  exit 1
fi

RESP=$(curl --max-time 5 -s -X POST "$BASE_URL/leave" \
  -H "Authorization: Bearer $TOKEN")

rm -f "$TOKEN_FILE"
echo "LEFT"
exit 0
