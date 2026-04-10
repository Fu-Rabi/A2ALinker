#!/bin/bash
# A2A Linker — Smart Wait Loop
# Optionally sends a message first, then blocks until a real message arrives.
# Handles [SYSTEM] join notifications and sub-5-min timeouts internally.
# Retries up to 3× on TIMEOUT_PING_FAILED (transient connectivity) before surfacing.
# Only surfaces: real MESSAGE_RECEIVED, 5+ min TIMEOUT_ROOM_ALIVE,
#                TIMEOUT_ROOM_CLOSED, or TIMEOUT_PING_FAILED (after retries).
#
# Usage (wait only):   bash .agents/skills/a2alinker/scripts/a2a-loop.sh [host|join]
# Usage (send + wait): bash .agents/skills/a2alinker/scripts/a2a-loop.sh [host|join] "message [OVER]"

ROLE="${1:-join}"
MESSAGE="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
MAX_PING_FAILS=3
PING_FAIL_COUNT=0

# Pre-flight: verify token exists and is non-empty
if [ ! -f "$TOKEN_FILE" ] || [ -z "$(cat "$TOKEN_FILE")" ]; then
  echo "ERROR: No valid token at $TOKEN_FILE. Run the connect script first."
  exit 1
fi

# If a message was provided, send it first
if [ -n "$MESSAGE" ]; then
  SEND_RESULT=$(bash "$SCRIPT_DIR/a2a-send.sh" "$ROLE" "$MESSAGE")
  echo "$SEND_RESULT"
  if [ "$SEND_RESULT" != "DELIVERED" ]; then
    exit 1
  fi
fi

# Wait loop — retry on noise and transient failures, surface only real events
while true; do
  RESULT=$(bash "$SCRIPT_DIR/a2a-wait-message.sh" "$ROLE")

  if echo "$RESULT" | grep -q '^MESSAGE_RECEIVED'; then
    if echo "$RESULT" | grep -q '\[SYSTEM\]'; then
      PING_FAIL_COUNT=0
      continue  # Connection notification — loop silently
    fi
    echo "$RESULT"
    exit 0
  elif echo "$RESULT" | grep -q '^TIMEOUT_ROOM_ALIVE'; then
    PING_FAIL_COUNT=0  # Server responded — reset failure counter
    LAST_SEEN=$(echo "$RESULT" | grep -o 'last_seen_ms=[0-9]*' | grep -o '[0-9]*$')
    if [ "${LAST_SEEN:-0}" -ge 300000 ]; then
      echo "$RESULT"  # 5+ min — surface to model
      exit 0
    fi
    continue  # Sub-5-min — loop silently
  elif echo "$RESULT" | grep -q '^TIMEOUT_ROOM_CLOSED'; then
    echo "$RESULT"  # Session gone — terminal
    exit 0
  else
    # TIMEOUT_PING_FAILED — may be transient; retry before surfacing
    PING_FAIL_COUNT=$((PING_FAIL_COUNT + 1))
    if [ "$PING_FAIL_COUNT" -le "$MAX_PING_FAILS" ]; then
      sleep 15
      continue
    fi
    echo "$RESULT"  # Give up after retries
    exit 0
  fi
done
