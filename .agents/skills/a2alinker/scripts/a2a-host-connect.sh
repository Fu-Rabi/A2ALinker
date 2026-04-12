#!/bin/bash
# A2A Linker — HOST connection script
# Registers with the server, creates a room, and prints the invite code.
# Optionally accepts a listen_ code to join a pre-staged listener room as HOST.
# Usage:
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh ["" true|false]
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh listen_XXXX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
LISTEN_CODE="${1:-}"
OLD_TOKEN=""
if [ -f /tmp/a2a_host_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_host_token)
fi

store_host_token() {
  local new_token="$1"
  echo "$new_token" > /tmp/a2a_host_token
  chmod 600 /tmp/a2a_host_token

  if [ -n "$OLD_TOKEN" ] && [ "$OLD_TOKEN" != "$new_token" ]; then
    (curl -s --max-time 5 -X POST "$BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
}

if [ -n "$LISTEN_CODE" ]; then
  # Listener flow: join the pre-staged room, become HOST
  # Now 1 round-trip: register + join in one call
  RESP=$(curl --max-time 15 -s -X POST "$BASE_URL/register-and-join/$LISTEN_CODE")

  if [ $? -ne 0 ] || [ -z "$RESP" ]; then
    echo "ERROR: Cannot reach A2A Linker server"
    exit 1
  fi

  if echo "$RESP" | grep -q '"error"'; then
    ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
    echo "ERROR: ${ERROR:-Listener code invalid or already used}"
    exit 1
  fi

  TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
  if [ -z "$TOKEN" ]; then
    echo "ERROR: Failed to parse token from response"
    exit 1
  fi

  store_host_token "$TOKEN"

  STATUS=$(echo "$RESP" | grep -o '([0-9]/[0-9] connected)')
  HEADLESS=$(echo "$RESP" | sed -En 's/.*"headless": *(true|false).*/\1/p')
  echo "STATUS: $STATUS"
  echo "ROLE: host"
  echo "HEADLESS: $HEADLESS"
  echo 'NEXT_STEP: HOST sends the first message. Use: bash .agents/skills/a2alinker/scripts/a2a-loop.sh host "your message [OVER]"'
else
  # Standard flow: register + create room in 1 round-trip
  HEADLESS_ARG="${2:-false}"
  RESP=$(curl --max-time 15 -s -X POST "$BASE_URL/setup" \
    -H "Content-Type: application/json" \
    -d "{\"type\": \"standard\", \"headless\": $HEADLESS_ARG}")

  if [ $? -ne 0 ] || [ -z "$RESP" ]; then
    echo "ERROR: Cannot reach A2A Linker server"
    exit 1
  fi

  TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
  INVITE=$(echo "$RESP" | grep -o 'invite_[a-zA-Z0-9]*')

  if [ -z "$TOKEN" ] || [ -z "$INVITE" ]; then
    ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
    echo "ERROR: ${ERROR:-Failed to create room}"
    exit 1
  fi

  store_host_token "$TOKEN"
  echo "ROLE: host"
  echo "INVITE_CODE: $INVITE"
  echo "HEADLESS_SET: $HEADLESS_ARG"
  echo 'NEXT_STEP: Share INVITE_CODE with the joiner. After the joiner connects, HOST sends the first message with: bash .agents/skills/a2alinker/scripts/a2a-loop.sh host "your message [OVER]"'
fi

exit 0
