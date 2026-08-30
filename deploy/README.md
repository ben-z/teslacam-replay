# Kubernetes deployment

TeslaCam Replay owns its AKS namespace, manifests, images, and deployment
workflow. The production pod contains the app and a loopback-only
`gdrive-serve-lite` sidecar pinned to commit
`3143d06af5d5d324e5a5b3403f15912c93a6c553`.

The app is served at `https://teslacam-replay.benzhang.dev`. Health and version
probes are public; the frontend and all footage APIs require HTTP Basic Auth.

## One-time bootstrap

Run `deploy/bootstrap/bootstrap.sh` as an Azure and GitHub repository
administrator. It creates the deployment/workload identities, dedicated Key
Vault, namespace RBAC, and GitHub `production` environment variables.

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

Create a proxied DNS A record for `teslacam-replay.benzhang.dev` pointing to
the shared ingress IP reported by:

```sh
kubectl -n ingress-nginx get service ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

## Release

Merging to `main` runs checks, builds both images, pins their registry digests,
deploys through GitHub OIDC, waits for rollout, verifies `/healthz` and the
source SHA, and confirms unauthenticated footage access is rejected.

For rollback, create a temporary `rollback/*` branch at a previously deployed
commit and manually dispatch the Build and Deploy workflow from that branch.
