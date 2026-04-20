#!/bin/bash
# A2A Linker — Send Message Script
# Sends a message to the session via HTTP POST and waits for DELIVERED confirmation.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] "message [OVER|STANDBY]"
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh "message [OVER|STANDBY]"   # defaults to host
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] --stdin < message.txt
# Exit 0 = DELIVERED, Exit 1 = NOT_DELIVERED

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
ROLE="host"
MESSAGE=""
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
READ_STDIN=false

if [ "${1:-}" = "host" ] || [ "${1:-}" = "join" ]; then
  ROLE="$1"
  MESSAGE="${2:-}"
else
  MESSAGE="${1:-}"
fi

TOKEN_FILE="/tmp/a2a_${ROLE}_token"

if [ "$MESSAGE" = "--stdin" ]; then
  READ_STDIN=true
  MESSAGE=""
fi

if [ "$READ_STDIN" = true ]; then
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "ERROR: No message provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] \"message [OVER]\""
  echo "   or: bash .agents/skills/a2alinker/scripts/a2a-send.sh \"message [OVER]\""
  echo "   or: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] --stdin < message.txt"
  exit 1
fi

TOKEN=$(a2a_read_primary_token "$ROLE") || {
  rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ERROR: Token file not found at $TOKEN_FILE. Run the connect script first."
  else
    echo "ERROR: Token file is empty. Run the connect script first."
  fi
  exit 1
}

# Write message to temp file to handle large content/special characters safely
TMPFILE=$(mktemp)
cat <<< "$MESSAGE" > "$TMPFILE"

RESP=$(curl --max-time 30 -s -w '\n%{http_code}' -X POST "$BASE_URL/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "@$TMPFILE")

# Cleanup temp file immediately
rm -f "$TMPFILE"

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q 'DELIVERED'; then
  echo "DELIVERED"
  exit 0
elif [ "$HTTP_CODE" = "401" ]; then
  echo "NOT_DELIVERED: Session expired or invalid (HTTP 401). Please re-run the connect script."
  exit 1
elif [ "$HTTP_CODE" = "503" ]; then
  echo "NOT_DELIVERED: Partner not connected (HTTP 503). Wait for partner to rejoin."
  exit 1
elif [ "$HTTP_CODE" = "429" ]; then
  echo "LOOP_DETECTED: Server paused the session due to repeated messages. Check the session and resume manually."
  exit 0
else
  echo "NOT_DELIVERED: $BODY (HTTP $HTTP_CODE)"
  exit 1
fi
