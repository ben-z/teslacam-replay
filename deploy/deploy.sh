#!/usr/bin/env bash
set -euo pipefail

readonly APP_NAME="teslacam-replay"
readonly APP_NAMESPACE="teslacam-replay"
readonly APP_INGRESS="${APP_NAME}-private"
readonly UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly MANIFEST="$SCRIPT_DIR/kubernetes/application.yaml"

require_variable() {
  local task_name="$1"
  if [[ -z "${!task_name:-}" ]]; then
    echo "Missing required environment variable: $task_name" >&2
    exit 1
  fi
}

for task_command in curl jq kubectl python3 sed; do
  if ! command -v "$task_command" >/dev/null 2>&1; then
    echo "Missing required command: $task_command" >&2
    exit 1
  fi
done

for task_variable in \
  APP_IMAGE \
  GDRIVE_IMAGE \
  SOURCE_SHA \
  AZURE_TENANT_ID \
  TESLACAM_KEY_VAULT_NAME \
  TESLACAM_SECRET_IDENTITY_CLIENT_ID \
  TESLACAM_URL; do
  require_variable "$task_variable"
done

if [[ ! "$APP_IMAGE" =~ ^ghcr\.io/ben-z/teslacam-replay@sha256:[0-9a-f]{64}$ ]]; then
  echo "APP_IMAGE must be an immutable teslacam-replay digest." >&2
  exit 1
fi

if [[ ! "$GDRIVE_IMAGE" =~ ^ghcr\.io/ben-z/teslacam-replay-gdrive-serve-lite@sha256:[0-9a-f]{64}$ ]]; then
  echo "GDRIVE_IMAGE must be an immutable gdrive-serve-lite digest." >&2
  exit 1
fi

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SOURCE_SHA must be a full lowercase Git commit SHA." >&2
  exit 1
fi

if [[ ! "$AZURE_TENANT_ID" =~ $UUID_PATTERN ]] ||
  [[ ! "$TESLACAM_SECRET_IDENTITY_CLIENT_ID" =~ $UUID_PATTERN ]]; then
  echo "Azure tenant and secret identity client IDs must be UUIDs." >&2
  exit 1
fi

if [[ ! "$TESLACAM_URL" =~ ^https://[a-zA-Z0-9.-]+$ ]]; then
  echo "TESLACAM_URL must be an HTTPS origin without a path." >&2
  exit 1
fi

task_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teslacam-deploy.XXXXXX")"
readonly task_rendered_manifest="$task_temp_dir/application.yaml"
cleanup() {
  rm -rf -- "$task_temp_dir"
}
trap cleanup EXIT

sed \
  -e "s|__APP_IMAGE__|$APP_IMAGE|g" \
  -e "s|__GDRIVE_IMAGE__|$GDRIVE_IMAGE|g" \
  -e "s|__AZURE_TENANT_ID__|$AZURE_TENANT_ID|g" \
  -e "s|__KEY_VAULT_NAME__|$TESLACAM_KEY_VAULT_NAME|g" \
  -e "s|__SECRET_IDENTITY_CLIENT_ID__|$TESLACAM_SECRET_IDENTITY_CLIENT_ID|g" \
  -e "s|__APP_ORIGIN__|$TESLACAM_URL|g" \
  "$MANIFEST" > "$task_rendered_manifest"

if grep -q '__[A-Z_]*__' "$task_rendered_manifest"; then
  echo "Rendered manifest still contains unresolved placeholders." >&2
  exit 1
fi

kubectl apply \
  --server-side \
  --force-conflicts \
  --field-manager=teslacam-replay-cd \
  -f "$task_rendered_manifest"

kubectl \
  --namespace "$APP_NAMESPACE" \
  patch secretproviderclass "$APP_NAME" \
  --type=merge \
  --patch '{"spec":{"parameters":{"userAssignedIdentityID":null}}}'

kubectl \
  --namespace "$APP_NAMESPACE" \
  rollout status "deployment/$APP_NAME" \
  --timeout=15m

task_live_app_image="$(kubectl -n "$APP_NAMESPACE" get "deployment/$APP_NAME" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="teslacam-replay")].image}')"
task_live_gdrive_image="$(kubectl -n "$APP_NAMESPACE" get "deployment/$APP_NAME" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="gdrive-serve-lite")].image}')"

if [[ "$task_live_app_image" != "$APP_IMAGE" ]] || [[ "$task_live_gdrive_image" != "$GDRIVE_IMAGE" ]]; then
  echo "Live image mismatch after rollout." >&2
  exit 1
fi

task_hostname="${TESLACAM_URL#https://}"
task_ingress_ready=false
for task_attempt in {1..60}; do
  task_ingress="$(kubectl -n "$APP_NAMESPACE" get "ingress/$APP_INGRESS" -o json)"
  jq -e --arg host "$task_hostname" \
    '.spec.ingressClassName == "tailnet" and [.spec.rules[].host] == [$host]' \
    <<<"$task_ingress" >/dev/null
  if task_private_ip="$(jq -er \
    '[.status.loadBalancer.ingress[]?.ip | select(. != null)] |
     select(length == 1) | .[0] |
     select(test("^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\."))' \
    <<<"$task_ingress")"; then
    task_ingress_ready=true
    break
  fi
  echo "Waiting for the Ingress Tailscale address (attempt $task_attempt/60)."
  sleep 5
done
if [[ "$task_ingress_ready" != true ]]; then
  echo "Ingress did not advertise a Tailscale address." >&2
  exit 1
fi
python3 - "$task_private_ip" <<'PYIP'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if address not in ipaddress.ip_network("100.64.0.0/10"):
    raise SystemExit(f"Ingress advertised a non-Tailscale IPv4 address: {address}")
PYIP

task_dns_ready=false
for task_attempt in {1..60}; do
  if python3 - "$task_hostname" "$task_private_ip" <<'PYDNS'
import socket
import sys

hostname, expected = sys.argv[1:]
addresses = {item[4][0] for item in socket.getaddrinfo(hostname, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)}
if addresses != {expected}:
    raise SystemExit(f"DNS for {hostname} must resolve only to {expected}, got {sorted(addresses)}")
PYDNS
  then
    task_dns_ready=true
    break
  fi
  echo "Waiting for private DNS (attempt $task_attempt/60)."
  sleep 5
done
if [[ "$task_dns_ready" != true ]]; then
  echo "Private DNS did not converge to the Ingress address." >&2
  exit 1
fi

task_curl=(curl --disable --noproxy "$task_hostname" --connect-timeout 5 --max-time 15
  --retry 6 --retry-delay 5 --retry-all-errors --silent --show-error)
require_private_peer() {
  if [[ "$1" != "$task_private_ip" ]]; then
    echo "Expected HTTPS connection to $task_private_ip, got $1." >&2
    exit 1
  fi
}

task_health_ip="$("${task_curl[@]}" --fail \
  --output "$task_temp_dir/health.json" --write-out '%{remote_ip}' "$TESLACAM_URL/healthz")"
require_private_peer "$task_health_ip"
jq -e '.status == "ok"' "$task_temp_dir/health.json" >/dev/null

task_version_ip="$("${task_curl[@]}" --fail \
  --output "$task_temp_dir/version.json" --write-out '%{remote_ip}' "$TESLACAM_URL/api/version")"
require_private_peer "$task_version_ip"
task_live_version="$(jq -er '.version | select(type == "string")' "$task_temp_dir/version.json")"
if [[ "$task_live_version" != "$SOURCE_SHA" ]]; then
  echo "Live application version mismatch: expected $SOURCE_SHA, got $task_live_version." >&2
  exit 1
fi

task_frontend_response="$("${task_curl[@]}" --fail --output "$task_temp_dir/frontend.html" \
  --write-out '%{http_code} %{remote_ip}' "$TESLACAM_URL/")"
read -r task_frontend_status task_frontend_ip <<<"$task_frontend_response"
require_private_peer "$task_frontend_ip"
if [[ "$task_frontend_status" != "200" ]] || ! grep -Fq '<div id="root"></div>' "$task_temp_dir/frontend.html"; then
  echo "Expected the frontend to load without a password, got HTTP $task_frontend_status." >&2
  exit 1
fi

task_api_ip="$("${task_curl[@]}" --fail \
  --dump-header "$task_temp_dir/status.headers" \
  --output "$task_temp_dir/status.json" --write-out '%{remote_ip}' "$TESLACAM_URL/api/status")"
require_private_peer "$task_api_ip"
jq -e '.storageBackend == "gdrive-serve-lite"' "$task_temp_dir/status.json" >/dev/null
grep -Fiq 'Cross-Origin-Resource-Policy: same-origin' "$task_temp_dir/status.headers"

task_foreign_response="$("${task_curl[@]}" --output /dev/null \
  --header 'Origin: https://untrusted.example.com' \
  --write-out '%{http_code} %{remote_ip}' "$TESLACAM_URL/api/status")"
read -r task_foreign_status task_foreign_ip <<<"$task_foreign_response"
require_private_peer "$task_foreign_ip"
if [[ "$task_foreign_status" != "403" ]]; then
  echo "Expected cross-origin API access to return 403, got $task_foreign_status." >&2
  exit 1
fi

echo "Deployed and verified $APP_IMAGE with gdrive sidecar $GDRIVE_IMAGE over trusted HTTPS at $task_private_ip"
