# Kubernetes deployment

TeslaCam Replay owns its AKS namespace, manifests, images, and deployment
workflow. The production pod contains the app and a loopback-only
`gdrive-serve-lite` sidecar pinned to commit
`3143d06af5d5d324e5a5b3403f15912c93a6c553`.

The app is served over Tailscale at `https://teslacam-replay.benzhang.dev`
with trusted HTTPS. Health and version probes are unauthenticated; the frontend
and all footage APIs require HTTP Basic Auth.

## One-time bootstrap

Run `deploy/bootstrap/bootstrap.sh` as an Azure and GitHub repository
administrator, with `TAILSCALE_API_TOKEN` set to a bootstrap access token
with the `federated_keys` scope and `TAILSCALE_CI_TAG` set to
`tag:unicorns-private-ci`. It creates the Azure deployment/workload
identities, dedicated Key Vault, namespace RBAC, exact GitHub production
Tailscale identity, and GitHub `production` environment variables.

Shared infrastructure must authorize the CI tag to reach
`svc:unicorns-private` on TCP 443. The workflow joins Tailscale using GitHub OIDC;
it does not require a stored Tailscale auth key or tailnet DNS.

Populate these required Key Vault secrets before deploying:

```sh
az keyvault secret set --vault-name VAULT_NAME \
  --name teslacam-rclone-config \
  --file /path/to/rclone.conf

az keyvault secret set --vault-name VAULT_NAME \
  --name teslacam-basic-auth-user \
  --value ben

task_password_file="$(mktemp)"
chmod 600 "$task_password_file"
openssl rand -hex 24 -out "$task_password_file"
az keyvault secret set --vault-name VAULT_NAME \
  --name teslacam-basic-auth-password \
  --file "$task_password_file"
rm -f -- "$task_password_file"
```

## Routing

The app declares its hostname and backend on an Ingress with class `tailnet`.
Shared infrastructure manages a DNS-only Cloudflare wildcard A record for
`*.benzhang.dev` pointing to the private gateway's Tailscale address. The shared
gateway manages automatic HTTPS. Apps need no individual DNS registration.

For a migration canary, apply `teslacam-replay-private` and verify the existing
hostname with `curl --resolve`. Once its status advertises the private address
and playback passes, remove the hostname's old explicit DNS records so the
wildcard applies. Remove the old public Ingress after private DNS and access
pass. Existing explicit records for other apps continue to take precedence
over the wildcard.

## Release

Merging to `main` runs checks, builds both images, pins their registry digests,
and deploys through GitHub OIDC. Verification waits for rollout, checks that
DNS resolves only to the advertised Tailscale IP, verifies trusted HTTPS and
the exact source SHA through that IP, and confirms unauthenticated footage
access is rejected.

For rollback, dispatch the current `main` workflow with the previously deployed
immutable images and application SHA. This uses the current routing and
deployment configuration without rebuilding the images:

```sh
gh workflow run docker.yml --ref main \
  -f rollback_app_image=ghcr.io/ben-z/teslacam-replay@sha256:APP_DIGEST \
  -f rollback_gdrive_image=ghcr.io/ben-z/teslacam-replay-gdrive-serve-lite@sha256:GDRIVE_DIGEST \
  -f rollback_source_sha=FULL_APPLICATION_SHA
```
