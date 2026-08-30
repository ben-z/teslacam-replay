#!/usr/bin/env bash
set -euo pipefail

readonly APP_NAME="teslacam-replay"
readonly APP_NAMESPACE="teslacam-replay"
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

for task_command in curl jq kubectl sed; do
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

task_rendered_manifest="$(mktemp "${TMPDIR:-/tmp}/teslacam-manifest.XXXXXX")"
cleanup() {
  rm -f -- "$task_rendered_manifest"
}
trap cleanup EXIT

sed \
  -e "s|__APP_IMAGE__|$APP_IMAGE|g" \
  -e "s|__GDRIVE_IMAGE__|$GDRIVE_IMAGE|g" \
  -e "s|__AZURE_TENANT_ID__|$AZURE_TENANT_ID|g" \
  -e "s|__KEY_VAULT_NAME__|$TESLACAM_KEY_VAULT_NAME|g" \
  -e "s|__SECRET_IDENTITY_CLIENT_ID__|$TESLACAM_SECRET_IDENTITY_CLIENT_ID|g" \
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

task_live_version=""
for task_attempt in {1..24}; do
  if task_health="$(curl --fail --max-time 15 --silent "$TESLACAM_URL/healthz" 2>/dev/null)" &&
    jq -e '.status == "ok"' <<<"$task_health" >/dev/null 2>&1 &&
    task_version_response="$(curl --fail --max-time 15 --silent "$TESLACAM_URL/api/version" 2>/dev/null)"; then
    task_live_version="$(jq -er '.version | select(type == "string")' \
      <<<"$task_version_response" 2>/dev/null || true)"
    if [[ "$task_live_version" == "$SOURCE_SHA" ]]; then
      break
    fi
  fi

  echo "Waiting for TeslaCam Replay $SOURCE_SHA (attempt $task_attempt/24)."
  sleep 5
done

if [[ "$task_live_version" != "$SOURCE_SHA" ]]; then
  echo "Live application version mismatch: expected $SOURCE_SHA, got ${task_live_version:-no valid response}." >&2
  exit 1
fi

task_unauthorized_status="$(curl --max-time 15 --output /dev/null --silent --write-out '%{http_code}' \
  "$TESLACAM_URL/api/status")"
if [[ "$task_unauthorized_status" != "401" ]]; then
  echo "Expected unauthenticated API access to return 401, got $task_unauthorized_status." >&2
  exit 1
fi

echo "Deployed and verified $APP_IMAGE with gdrive sidecar $GDRIVE_IMAGE"
