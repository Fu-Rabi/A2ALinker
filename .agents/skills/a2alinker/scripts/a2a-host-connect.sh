#!/bin/bash
# A2A Linker — HOST connection script
# Registers with the server, creates a room, and prints the invite code.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh

SERVER="broker.a2alinker.net"
BASE_URL="https://$SERVER"

# Clean up stale session from previous run (best-effort, ignore failure)
if [ -f /tmp/a2a_host_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_host_token 2>/dev/null)
  if [ -n "$OLD_TOKEN" ]; then
    curl -s --max-time 5 -X POST "$BASE_URL/leave" \
      -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 || true
  fi
  rm -f /tmp/a2a_host_token
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

echo "$TOKEN" > /tmp/a2a_host_token

# Create room
RESP=$(curl --max-time 10 -s -X POST "$BASE_URL/create" \
  -H "Authorization: Bearer $TOKEN")
if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
  exit 1
fi

INVITE=$(echo "$RESP" | grep -o 'invite_[a-zA-Z0-9]*')
if [ -z "$INVITE" ]; then
  echo "ERROR: Failed to create room"
  exit 1
fi

echo "INVITE_CODE: $INVITE"
exit 0
