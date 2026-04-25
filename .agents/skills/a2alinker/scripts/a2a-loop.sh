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
SURFACE_JOIN_NOTICE=false
READ_STDIN=false
INFLIGHT_PATH="$(a2a_inflight_message_path_for_role "$ROLE" 2>/dev/null || true)"
ARTIFACT_STANDBY_BYTES_THRESHOLD="${A2A_ARTIFACT_STANDBY_BYTES_THRESHOLD:-2048}"
ARTIFACT_STANDBY_LONG_LINES_THRESHOLD="${A2A_ARTIFACT_STANDBY_LONG_LINES_THRESHOLD:-10}"

case "$(printf '%s' "${A2A_SURFACE_JOIN_NOTICE:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    SURFACE_JOIN_NOTICE=true
    ;;
esac

normalize_loop_message() {
  local payload="$1"
  if printf '%s' "$payload" | grep -Eq '\[(OVER|STANDBY)\][[:space:]]*$'; then
    printf '%s' "$payload"
    return 0
  fi
  printf '%s [OVER]' "$payload"
}

loop_message_signal() {
  local payload="$1"
  if printf '%s' "$payload" | grep -Eq '\[STANDBY\][[:space:]]*$'; then
    printf 'STANDBY\n'
    return 0
  fi
  if printf '%s' "$payload" | grep -Eq '\[OVER\][[:space:]]*$'; then
    printf 'OVER\n'
    return 0
  fi
  printf '\n'
}

loop_message_body() {
  local payload="$1"
  printf '%s' "$payload" | perl -0pe 's/\s*\[(?:OVER|STANDBY)\]\s*$//s'
}

loop_payload_is_artifact_like() {
  local payload="$1"
  local bytes line_count
  bytes=$(printf '%s' "$payload" | wc -c | tr -d '[:space:]')
  if [ "${bytes:-0}" -gt "$ARTIFACT_STANDBY_BYTES_THRESHOLD" ]; then
    return 0
  fi
  if printf '%s' "$payload" | grep -Eq '^[[:space:]]*<!DOCTYPE html>|^[[:space:]]*<html\b|^[[:space:]]*<\?xml\b'; then
    return 0
  fi
  if printf '%s' "$payload" | grep -Eq '^[[:space:]]*[\[{]'; then
    if printf '%s' "$payload" | grep -Eq '^[[:space:]]*\{[[:space:]]*$|^[[:space:]]*\[[[:space:]]*$|"[[:space:]]*:'; then
      return 0
    fi
  fi
  if printf '%s' "$payload" | grep -Fq '```'; then
    return 0
  fi
  line_count=$(printf '%s' "$payload" | awk 'END { print NR }')
  if [ "${line_count:-0}" -ge "$ARTIFACT_STANDBY_LONG_LINES_THRESHOLD" ]; then
    return 0
  fi
  return 1
}

loop_payload_is_reply_seeking() {
  local payload="$1"
  local normalized
  normalized=$(printf '%s' "$payload" | tr '\n' ' ')
  if printf '%s' "$normalized" | grep -Eiq '\bplease[[:space:]]+review\b|\breview\b.{0,120}\breturn\b|\breturn\b.{0,120}\b(approved|blocked|issues)\b|\bapprove[[:space:]]+or[[:space:]]+blocked\b|\breply[[:space:]]+with\b|\brespond[[:space:]]+with\b|\bsend[[:space:]]+back\b.{0,120}\b(approved|blocked|issues)\b'; then
    return 0
  fi
  return 1
}

guard_standby_artifact_send() {
  local payload="$1"
  local signal body
  local artifact_like=false
  local reply_request=false
  local artifact_allowed=false
  local reply_allowed=false
  local -a reasons=()
  local reason_csv
  local reason_text
  signal="$(loop_message_signal "$payload")"
  if [ "$signal" != "STANDBY" ]; then
    return 0
  fi

  printf '%s\n' "Notice: this message is being sent as STANDBY; the remote agent is not expected to reply automatically." >&2
  body="$(loop_message_body "$payload")"

  if loop_payload_is_artifact_like "$body"; then
    artifact_like=true
  fi
  if loop_payload_is_reply_seeking "$body"; then
    reply_request=true
  fi

  if [ "$artifact_like" = false ] && [ "$reply_request" = false ]; then
    return 0
  fi

  if [ "${A2A_ALLOW_STANDBY_ARTIFACT_SEND:-0}" = "1" ]; then
    artifact_allowed=true
  fi
  if [ "${A2A_ALLOW_STANDBY_REPLY_REQUEST:-0}" = "1" ]; then
    reply_allowed=true
  fi

  if [ "$artifact_like" = true ] && [ "$artifact_allowed" = false ]; then
    reasons+=("artifact-like")
  fi
  if [ "$reply_request" = true ] && [ "$reply_allowed" = false ]; then
    reasons+=("reply-seeking")
  fi

  if [ "${#reasons[@]}" -eq 0 ]; then
    reason_csv=""
    if [ "$artifact_like" = true ]; then
      reason_csv="artifact_like"
    fi
    if [ "$reply_request" = true ]; then
      if [ -n "$reason_csv" ]; then
        reason_csv="$reason_csv,reply_request"
      else
        reason_csv="reply_request"
      fi
    fi
    if [ -n "$reason_csv" ]; then
      a2a_debug_log "$ROLE" "loop:standby_guard reasons=$reason_csv override=1"
    fi
    return 0
  fi

  reason_csv=$(printf '%s\n' "${reasons[@]}" | sed 's/-/_/g' | paste -sd, -)
  if [ "${#reasons[@]}" -eq 1 ]; then
    reason_text="${reasons[0]}"
  else
    reason_text="${reasons[0]} and ${reasons[1]}"
  fi
  a2a_debug_log "$ROLE" "loop:standby_guard reasons=$reason_csv"

  if [ -t 0 ] && [ -t 1 ]; then
    local answer
    printf '%s' "This STANDBY message looks ${reason_text}. The remote side may store it, but it will not automatically review or answer it. Send anyway? [y/N] " >&2
    read -r answer || true
    case "$(printf '%s' "${answer:-}" | tr '[:upper:]' '[:lower:]')" in
      y|yes)
        a2a_debug_log "$ROLE" "loop:standby_guard reasons=$reason_csv confirmed=1"
        return 0
        ;;
      *)
        a2a_debug_log "$ROLE" "loop:standby_guard reasons=$reason_csv denied=1"
        echo "ERROR: Refusing to send $reason_text STANDBY message without explicit confirmation." >&2
        return 1
        ;;
    esac
  fi

  a2a_debug_log "$ROLE" "loop:standby_guard reasons=$reason_csv blocked_noninteractive=1"
  echo "ERROR: Refusing to send $reason_text STANDBY message in non-interactive mode. Set the appropriate A2A_ALLOW_STANDBY_* override(s) to bypass." >&2
  return 1
}

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
  MESSAGE="$(cat)"
  MESSAGE="$(normalize_loop_message "$MESSAGE")"
  guard_standby_artifact_send "$MESSAGE" || exit 1
  a2a_debug_log "$ROLE" "loop:send stdin=1"
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
elif [ -n "$MESSAGE" ]; then
  guard_standby_artifact_send "$MESSAGE" || exit 1
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
        if [ "$SURFACE_JOIN_NOTICE" = true ]; then
          echo "$RESULT"
          exit 0
        fi
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
