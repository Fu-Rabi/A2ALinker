#!/bin/bash

a2a_read_broker_from_artifact() {
  local artifact_path="$1"
  if [ ! -f "$artifact_path" ]; then
    return 1
  fi

  local broker
  broker=$(sed -En 's/.*"brokerEndpoint"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$artifact_path" | head -n 1)
  if [ -n "$broker" ]; then
    printf '%s\n' "$broker"
    return 0
  fi

  return 1
}

a2a_read_field_from_artifact() {
  local artifact_path="$1"
  local field_name="$2"
  if [ ! -f "$artifact_path" ]; then
    return 1
  fi

  local value
  value=$(sed -En "s/.*\"${field_name}\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/p" "$artifact_path" | head -n 1)
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi

  return 1
}

a2a_resolve_base_url() {
  if [ -n "${A2A_BASE_URL:-}" ]; then
    printf '%s\n' "$A2A_BASE_URL"
    return 0
  fi

  if [ -n "${A2A_SERVER:-}" ]; then
    case "$A2A_SERVER" in
      http://*|https://*)
        printf '%s\n' "$A2A_SERVER"
        ;;
      *)
        printf 'https://%s\n' "$A2A_SERVER"
        ;;
    esac
    return 0
  fi

  local cwd
  cwd="${PWD:-$(pwd)}"
  for artifact_path in \
    "$cwd/.a2a-host-session.json" \
    "$cwd/.a2a-listener-session.json" \
    "$cwd/.a2a-session-policy.json" \
    "$cwd/.a2a-listener-policy.json"
  do
    if a2a_read_broker_from_artifact "$artifact_path"; then
      return 0
    fi
  done

  printf '%s\n' "http://127.0.0.1:3000"
}

a2a_resolve_token_dir() {
  local dir_path
  if [ -n "${A2A_STATE_DIR:-}" ]; then
    dir_path="$A2A_STATE_DIR"
  elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "${XDG_RUNTIME_DIR}" ]; then
    dir_path="${XDG_RUNTIME_DIR}/a2alinker"
  elif [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR}" ]; then
    dir_path="${TMPDIR%/}/a2alinker"
  else
    dir_path="${HOME}/.a2a"
  fi

  mkdir -p "$dir_path"
  chmod 700 "$dir_path" 2>/dev/null || true
  printf '%s\n' "$dir_path"
}

a2a_resolve_token_path() {
  local role="$1"
  printf '%s/a2a_%s_token\n' "$(a2a_resolve_token_dir)" "$role"
}

a2a_migrate_legacy_token() {
  local role="$1"
  local new_path legacy_path
  new_path="$(a2a_resolve_token_path "$role")"
  legacy_path="/tmp/a2a_${role}_token"

  if [ -f "$legacy_path" ] && [ ! -f "$new_path" ]; then
    mv "$legacy_path" "$new_path"
    chmod 600 "$new_path" 2>/dev/null || true
  elif [ -f "$legacy_path" ]; then
    rm -f "$legacy_path"
  fi
}

a2a_write_token() {
  local token_path="$1"
  local token_value="$2"
  (umask 077; printf '%s\n' "$token_value" > "$token_path")
}
