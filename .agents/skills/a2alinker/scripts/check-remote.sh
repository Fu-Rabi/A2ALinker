#!/bin/bash
# A2A Linker — Remote Health Check
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"

RESP=$(curl --max-time 5 -s "$BASE_URL/health")
if [ $? -eq 0 ] && echo "$RESP" | grep -q '"ok"'; then
  echo "A2ALinker HTTP API is READY"
  exit 0
else
  echo "FAILED: A2ALinker HTTP API is unreachable or unhealthy"
  exit 1
fi
