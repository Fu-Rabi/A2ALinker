#!/bin/bash
# A2A Linker — Smart Wait Loop
# Optionally sends a message first, then blocks until a real message arrives.
# Handles [SYSTEM] join notifications and sub-5-min timeouts internally.
# Retries up to 3× on TIMEOUT_PING_FAILED (transient connectivity) before surfacing.
# Only surfaces: real MESSAGE_RECEIVED, non-join [SYSTEM] control events,
#                5+ min TIMEOUT_ROOM_ALIVE, TIMEOUT_ROOM_CLOSED,
#                or TIMEOUT_PING_FAILED (after retries).
#
# Usage (wait only):   bash .agents/skills/a2alinker/scripts/a2a-loop.sh [host|join]
# Usage (send + wait): bash .agents/skills/a2alinker/scripts/a2a-loop.sh [host|join] "message [OVER]"
# Usage (stdin):       bash .agents/skills/a2alinker/scripts/a2a-loop.sh [host|join] --stdin < message.txt

ROLE="${1:-join}"
MESSAGE="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
MAX_PING_FAILS=3
PING_FAIL_COUNT=0
MAX_WAIT_CONFLICTS="${A2A_MAX_WAIT_CONFLICTS:-3}"
WAIT_CONFLICT_COUNT=0
READ_STDIN=false
INFLIGHT_PATH="$(a2a_inflight_message_path_for_role "$ROLE" 2>/dev/null || true)"

if [ "$MESSAGE" = "--stdin" ]; then
  READ_STDIN=true
  MESSAGE=""
fi

# Pre-flight: verify token exists and is non-empty
if [ ! -f "$TOKEN_FILE" ] || [ -z "$(cat "$TOKEN_FILE")" ]; then
  echo "ERROR: No valid token at $TOKEN_FILE. Run the connect script first."
  exit 1
fi

# If a message was provided, send it first
if [ "$READ_STDIN" = true ]; then
  a2a_debug_log "$ROLE" "loop:send stdin=1"
  SEND_RESULT=$(bash "$SCRIPT_DIR/a2a-send.sh" "$ROLE" --stdin)
  echo "$SEND_RESULT"
  a2a_debug_log "$ROLE" "loop:send_result result=$SEND_RESULT"
  if [ "$SEND_RESULT" != "DELIVERED" ]; then
    exit 1
  fi
  if [ -n "$INFLIGHT_PATH" ]; then
    mkdir -p "$(dirname "$INFLIGHT_PATH")"
    cat > "$INFLIGHT_PATH"
  fi
elif [ -n "$MESSAGE" ]; then
  a2a_debug_log "$ROLE" "loop:send message_present=yes"
  SEND_RESULT=$(bash "$SCRIPT_DIR/a2a-send.sh" "$ROLE" "$MESSAGE")
  echo "$SEND_RESULT"
  a2a_debug_log "$ROLE" "loop:send_result result=$SEND_RESULT"
  if [ "$SEND_RESULT" != "DELIVERED" ]; then
    exit 1
  fi
  if [ -n "$INFLIGHT_PATH" ]; then
    mkdir -p "$(dirname "$INFLIGHT_PATH")"
    printf '%s\n' "$MESSAGE" > "$INFLIGHT_PATH"
  fi
fi

# Wait loop — retry on noise and transient failures, surface only real events
while true; do
  RESULT=$(bash "$SCRIPT_DIR/a2a-wait-message.sh" "$ROLE")
  a2a_debug_log "$ROLE" "loop:wait_result first_line=$(printf '%s' "$RESULT" | head -n 1)"

  if echo "$RESULT" | grep -q '^MESSAGE_RECEIVED'; then
    WAIT_CONFLICT_COUNT=0
    if echo "$RESULT" | grep -q '\[SYSTEM'; then
      PING_FAIL_COUNT=0

      # Don't exit on routine 'joined' or 'live' messages. Keep waiting.
      if echo "$RESULT" | grep -i -q -E '(has joined|session is live)'; then
        # The broker may have bundled a real partner message in the same payload
        # after the SYSTEM block. If so, extract and surface it now — we cannot
        # call a2a-wait-message.sh again because the broker already delivered it.
        SECOND_MSG=$(echo "$RESULT" | awk '
          /^MESSAGE_RECEIVED/ { count++; if (count == 2) { found=1 } }
          { if (found) print }
        ')
        if [ -n "$SECOND_MSG" ]; then
          echo "$SECOND_MSG"
          exit 0
        fi
        continue
      fi

      echo "$RESULT"
      # Exit on critical system alerts (closed, paused)
      exit 0
    fi
    echo "$RESULT"
    exit 0
  elif echo "$RESULT" | grep -q '^TIMEOUT_ROOM_ALIVE'; then
    PING_FAIL_COUNT=0  # Server responded — reset failure counter
    WAIT_CONFLICT_COUNT=0
    LAST_SEEN=$(echo "$RESULT" | grep -o 'last_seen_ms=[0-9]*' | grep -o '[0-9]*$')
    if [ "${LAST_SEEN:-0}" -ge 300000 ]; then
      echo "$RESULT"  # 5+ min — surface to model
      exit 0
    fi
    continue  # Sub-5-min — loop silently
  elif echo "$RESULT" | grep -q '^TIMEOUT_ROOM_CLOSED'; then
    WAIT_CONFLICT_COUNT=0
    echo "$RESULT"  # Session gone — terminal
    exit 0
  elif echo "$RESULT" | grep -q '^TIMEOUT_WAIT_EXPIRED'; then
    PING_FAIL_COUNT=0
    WAIT_CONFLICT_COUNT=0
    continue
  elif echo "$RESULT" | grep -q '^WAIT_ALREADY_PENDING'; then
    WAIT_CONFLICT_COUNT=$((WAIT_CONFLICT_COUNT + 1))
    a2a_debug_log "$ROLE" "loop:wait_conflict count=$WAIT_CONFLICT_COUNT max=$MAX_WAIT_CONFLICTS"
    if [ "$WAIT_CONFLICT_COUNT" -lt "$MAX_WAIT_CONFLICTS" ]; then
      sleep 2
      continue
    fi
    echo "$RESULT"
    exit 0
  elif echo "$RESULT" | grep -q '^WAIT_BROKER_DRAINING'; then
    WAIT_CONFLICT_COUNT=0
    echo "$RESULT"
    exit 0
  elif echo "$RESULT" | grep -q '^WAIT_UNAUTHORIZED'; then
    WAIT_CONFLICT_COUNT=0
    echo "$RESULT"
    exit 0
  else
    # TIMEOUT_PING_FAILED — may be transient; retry before surfacing
    PING_FAIL_COUNT=$((PING_FAIL_COUNT + 1))
    WAIT_CONFLICT_COUNT=0
    if [ "$PING_FAIL_COUNT" -le "$MAX_PING_FAILS" ]; then
      sleep 15
      continue
    fi
    echo "$RESULT"  # Give up after retries
    exit 0
  fi
done
