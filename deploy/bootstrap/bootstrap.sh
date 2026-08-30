#!/usr/bin/env bash
set -euo pipefail

readonly APP_NAMESPACE="teslacam-replay"
readonly APP_SERVICE_ACCOUNT="teslacam-replay"
readonly APP_URL="https://teslacam-replay.benzhang.dev"
readonly AZURE_RESOURCE_GROUP="unicorns-aks-rg"
readonly AZURE_AKS_CLUSTER_NAME="unicorns-aks"
readonly GITHUB_REPOSITORY="ben-z/teslacam-replay"
readonly GITHUB_ENVIRONMENT="production"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

for task_command in az gh jq sed; do
  if ! command -v "$task_command" >/dev/null 2>&1; then
    echo "Missing required command: $task_command" >&2
    exit 1
  fi
done

if ! az bicep version >/dev/null 2>&1; then
  echo "Missing Azure Bicep CLI. Run: az bicep install" >&2
  exit 1
fi

az bicep build --file "$SCRIPT_DIR/main.bicep" --stdout >/dev/null
task_repo_admin="$(gh api "repos/$GITHUB_REPOSITORY" --jq '.permissions.admin')"
if [[ "$task_repo_admin" != "true" ]]; then
  echo "GitHub authentication must have administrator access to $GITHUB_REPOSITORY." >&2
  exit 1
fi

task_subscription_id="$(az account show --query id -o tsv)"
task_tenant_id="$(az account show --query tenantId -o tsv)"
task_operator_id="$(az ad signed-in-user show --query id -o tsv)"
task_oidc_issuer="$(az aks show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_AKS_CLUSTER_NAME" \
  --query oidcIssuerProfile.issuerUrl \
  -o tsv)"

if [[ -z "$task_oidc_issuer" ]]; then
  echo "AKS OIDC issuer is missing." >&2
  exit 1
fi

task_outputs="$(az deployment group create \
  --name teslacam-replay-bootstrap \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters \
    aksName="$AZURE_AKS_CLUSTER_NAME" \
    aksOidcIssuerUrl="$task_oidc_issuer" \
    githubRepository="$GITHUB_REPOSITORY" \
    githubEnvironment="$GITHUB_ENVIRONMENT" \
    kubernetesNamespace="$APP_NAMESPACE" \
    kubernetesServiceAccount="$APP_SERVICE_ACCOUNT" \
    operatorObjectId="$task_operator_id" \
  --query properties.outputs \
  -o json)"

task_deployer_client_id="$(jq -er '.deployerClientId.value' <<<"$task_outputs")"
task_deployer_principal_id="$(jq -er '.deployerPrincipalId.value' <<<"$task_outputs")"
task_key_vault_name="$(jq -er '.keyVaultName.value' <<<"$task_outputs")"
task_secret_identity_client_id="$(jq -er '.secretIdentityClientId.value' <<<"$task_outputs")"

task_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teslacam-bootstrap.XXXXXX")"
cleanup() {
  rm -rf -- "$task_temp_dir"
}
trap cleanup EXIT

sed "s/__DEPLOYER_PRINCIPAL_ID__/$task_deployer_principal_id/g" \
  "$SCRIPT_DIR/namespace-rbac.yaml" > "$task_temp_dir/namespace-rbac.yaml"

az aks command invoke \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_AKS_CLUSTER_NAME" \
  --command 'kubectl apply -f namespace-rbac.yaml' \
  --file "$task_temp_dir/namespace-rbac.yaml" \
  --query logs \
  -o tsv

gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/$GITHUB_REPOSITORY/environments/$GITHUB_ENVIRONMENT" \
  --input - <<'JSON' >/dev/null
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON

ensure_deployment_branch_policy() {
  local task_pattern="$1"
  local task_count
  task_count="$(gh api \
    "repos/$GITHUB_REPOSITORY/environments/$GITHUB_ENVIRONMENT/deployment-branch-policies" \
    --jq "[.branch_policies[] | select(.name == \"$task_pattern\" and .type == \"branch\")] | length")"
  if [[ "$task_count" == "0" ]]; then
    gh api --method POST \
      "repos/$GITHUB_REPOSITORY/environments/$GITHUB_ENVIRONMENT/deployment-branch-policies" \
      -f name="$task_pattern" -f type=branch --silent
  elif [[ "$task_count" != "1" ]]; then
    echo "Expected exactly one deployment policy for $task_pattern." >&2
    exit 1
  fi
}

ensure_deployment_branch_policy main
ensure_deployment_branch_policy 'rollback/*'

set_environment_variable() {
  gh variable set "$1" --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$2"
}

set_environment_variable AZURE_CLIENT_ID "$task_deployer_client_id"
set_environment_variable AZURE_TENANT_ID "$task_tenant_id"
set_environment_variable AZURE_SUBSCRIPTION_ID "$task_subscription_id"
set_environment_variable AZURE_RESOURCE_GROUP "$AZURE_RESOURCE_GROUP"
set_environment_variable AZURE_AKS_CLUSTER_NAME "$AZURE_AKS_CLUSTER_NAME"
set_environment_variable TESLACAM_KEY_VAULT_NAME "$task_key_vault_name"
set_environment_variable TESLACAM_SECRET_IDENTITY_CLIENT_ID "$task_secret_identity_client_id"
set_environment_variable TESLACAM_URL "$APP_URL"

echo "TeslaCam deployment identity, namespace RBAC, Key Vault, and GitHub environment are configured."
echo "Key Vault: $task_key_vault_name"
