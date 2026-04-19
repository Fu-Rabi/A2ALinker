#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_DIR="$ROOT_DIR/.agents/skills/a2alinker/scripts"
SERVER_JS="$ROOT_DIR/dist/server.js"

HTTP_PORT="${A2A_E2E_HTTP_PORT:-3000}"
BASE_URL="http://127.0.0.1:${HTTP_PORT}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/a2a-http-e2e.XXXXXX")"
BROKER_LOG="$TMP_ROOT/broker.log"
BROKER_PID=""

cleanup() {
  if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  rm -f /tmp/a2a_host_token /tmp/a2a_join_token
  rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

fail() {
  echo "E2E FAILED: $*" >&2
  if [ -f "$BROKER_LOG" ]; then
    echo "--- broker.log ---" >&2
    cat "$BROKER_LOG" >&2
  fi
  exit 1
}

require_file() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    fail "Required file missing: $file_path"
  fi
}

run_in_dir() {
  local workdir="$1"
  shift
  mkdir -p "$workdir"
  (
    cd "$workdir"
    "$@"
  )
}

extract_field() {
  local prefix="$1"
  local content="$2"
  printf '%s\n' "$content" | sed -n "s/^${prefix}[[:space:]]*//p" | head -n 1
}

wait_for_health() {
  local attempts=30
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl --max-time 2 -s "$BASE_URL/health" | grep -q '"ok"'; then
      return 0
    fi
    sleep 1
  done
  fail "Broker did not become healthy at $BASE_URL"
}

wait_for_non_system_message() {
  local role="$1"
  local workdir="$2"
  local attempts=5
  local output=""
  local i
  for ((i=1; i<=attempts; i++)); do
    output="$(run_in_dir "$workdir" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-wait-message.sh" "$role")"
    if ! printf '%s\n' "$output" | grep -q '^\[SYSTEM\]:'; then
      printf '%s\n' "$output"
      return 0
    fi
  done
  fail "Did not receive a non-system message for role '$role' after ${attempts} waits"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if ! printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    printf 'Unexpected output for %s:\n%s\n' "$label" "$haystack" >&2
    fail "Missing expected text: $needle"
  fi
}

close_session_if_present() {
  local role="$1"
  local workdir="$2"
  if [ -f "/tmp/a2a_${role}_token" ]; then
    run_in_dir "$workdir" env A2A_BASE_URL="$BASE_URL" A2A_ALLOW_CLOSE=true bash "$SKILL_DIR/a2a-leave.sh" "$role" >/dev/null 2>&1 || true
  fi
}

require_file "$SERVER_JS"
require_file "$SKILL_DIR/a2a-listen.sh"
require_file "$SKILL_DIR/a2a-host-connect.sh"
require_file "$SKILL_DIR/a2a-join-connect.sh"
require_file "$SKILL_DIR/a2a-send.sh"
require_file "$SKILL_DIR/a2a-wait-message.sh"

echo "Starting local broker on $BASE_URL"
ALLOW_INSECURE_HTTP_LOCAL_DEV=true \
HTTP_PORT="$HTTP_PORT" \
NODE_ENV=development \
node "$SERVER_JS" >"$BROKER_LOG" 2>&1 &
BROKER_PID=$!

wait_for_health

CASE1_LISTENER_DIR="$TMP_ROOT/case1-listener"
CASE1_HOST_DIR="$TMP_ROOT/case1-host"
CASE2_HOST_DIR="$TMP_ROOT/case2-host"
CASE2_JOIN_DIR="$TMP_ROOT/case2-join"

echo "Case 1: listener code redemption"
rm -f /tmp/a2a_host_token /tmp/a2a_join_token
LISTENER_OUTPUT="$(run_in_dir "$CASE1_LISTENER_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-listen.sh" true)"
LISTENER_CODE="$(extract_field 'LISTENER_CODE:' "$LISTENER_OUTPUT")"
[ -n "$LISTENER_CODE" ] || fail "Listener code missing in case 1"
HOST_ATTACH_OUTPUT="$(run_in_dir "$CASE1_HOST_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-host-connect.sh" "$LISTENER_CODE")"
assert_contains "$HOST_ATTACH_OUTPUT" "STATUS: (2/2 connected)" "case 1 host attach"

HOST_SEND_OUTPUT="$(run_in_dir "$CASE1_HOST_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-send.sh" host "listener-case ping from host [OVER]")"
assert_contains "$HOST_SEND_OUTPUT" "DELIVERED" "case 1 host send"

LISTENER_WAIT_OUTPUT="$(wait_for_non_system_message join "$CASE1_LISTENER_DIR")"
assert_contains "$LISTENER_WAIT_OUTPUT" "listener-case ping from host" "case 1 listener receive"

JOIN_SEND_OUTPUT="$(run_in_dir "$CASE1_LISTENER_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-send.sh" join "listener-case pong from join [STANDBY]")"
assert_contains "$JOIN_SEND_OUTPUT" "DELIVERED" "case 1 join send"

HOST_WAIT_OUTPUT="$(wait_for_non_system_message host "$CASE1_HOST_DIR")"
assert_contains "$HOST_WAIT_OUTPUT" "listener-case pong from join" "case 1 host receive"

close_session_if_present host "$CASE1_HOST_DIR"
rm -f /tmp/a2a_host_token /tmp/a2a_join_token

echo "Case 2: invite code redemption"
HOST_CREATE_OUTPUT="$(run_in_dir "$CASE2_HOST_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-host-connect.sh" "" false)"
INVITE_CODE="$(extract_field 'INVITE_CODE:' "$HOST_CREATE_OUTPUT")"
[ -n "$INVITE_CODE" ] || fail "Invite code missing in case 2"

JOIN_CONNECT_OUTPUT="$(run_in_dir "$CASE2_JOIN_DIR" env A2A_BASE_URL="$BASE_URL" A2A_INVITE="$INVITE_CODE" bash "$SKILL_DIR/a2a-join-connect.sh")"
assert_contains "$JOIN_CONNECT_OUTPUT" "STATUS: (2/2 connected)" "case 2 join connect"

HOST_SEND_OUTPUT="$(run_in_dir "$CASE2_HOST_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-send.sh" host "invite-case ping from host [OVER]")"
assert_contains "$HOST_SEND_OUTPUT" "DELIVERED" "case 2 host send"

JOIN_WAIT_OUTPUT="$(wait_for_non_system_message join "$CASE2_JOIN_DIR")"
assert_contains "$JOIN_WAIT_OUTPUT" "invite-case ping from host" "case 2 join receive"

JOIN_SEND_OUTPUT="$(run_in_dir "$CASE2_JOIN_DIR" env A2A_BASE_URL="$BASE_URL" bash "$SKILL_DIR/a2a-send.sh" join "invite-case pong from join [STANDBY]")"
assert_contains "$JOIN_SEND_OUTPUT" "DELIVERED" "case 2 join send"

HOST_WAIT_OUTPUT="$(wait_for_non_system_message host "$CASE2_HOST_DIR")"
assert_contains "$HOST_WAIT_OUTPUT" "invite-case pong from join" "case 2 host receive"

close_session_if_present host "$CASE2_HOST_DIR"
rm -f /tmp/a2a_host_token /tmp/a2a_join_token

echo "E2E OK: listener and invite flows both passed against $BASE_URL"
