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
