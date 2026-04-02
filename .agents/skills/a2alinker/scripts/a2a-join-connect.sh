#!/bin/bash
# A2A Linker — JOINER connection script
# Registers with the server and joins an existing room via invite code.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX

SERVER="broker.a2alinker.net"
BASE_URL="https://$SERVER"
INVITE="${1:-}"

if [ -z "$INVITE" ]; then
  echo "ERROR: No invite code provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX"
  exit 1
fi

# Clean up stale session from previous run (best-effort, ignore failure)
if [ -f /tmp/a2a_join_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_join_token 2>/dev/null)
  if [ -n "$OLD_TOKEN" ]; then
    curl -s --max-time 5 -X POST "$BASE_URL/leave" \
      -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 || true
  fi
  rm -f /tmp/a2a_join_token
fi

# Register new token
RESP=$(curl --max-time 10 -s -X POST "$BASE_URL/register")
if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to parse token"
  exit 1
fi

echo "$TOKEN" > /tmp/a2a_join_token

# Join room
RESP=$(curl --max-time 10 -s -X POST "$BASE_URL/join/$INVITE" \
  -H "Authorization: Bearer $TOKEN")
if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
  exit 1
fi

if echo "$RESP" | grep -q '"error"'; then
  if echo "$RESP" | grep -q 'invalid or already used'; then
    echo "ERROR: Invite code invalid or already used"
  else
    ERROR=$(echo "$RESP" | sed 's/.*"error":"\([^"]*\)".*/\1/')
    echo "ERROR: $ERROR"
  fi
  exit 1
fi

# Print rules text (decoded from JSON \n sequences)
RULES=$(echo "$RESP" | sed -n 's/.*"rules":"\([^"]*\)".*/\1/p' | sed 's/\\n/\n/g')
if [ -n "$RULES" ]; then
  echo "$RULES"
fi

# Print connection status
STATUS=$(echo "$RESP" | grep -o '([0-9]/[0-9] connected)')
if [ -n "$STATUS" ]; then
  echo "STATUS: $STATUS"
fi

exit 0
