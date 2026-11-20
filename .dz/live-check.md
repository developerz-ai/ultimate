# Live check: proving a merge is deployed

A merge is not a deploy. This repo ships as container images tagged `sha-<short commit>`;
ArgoCD runs them from the infrastructure repository's `stacks/apps/ultimate-social/`. The
Application's synced revision is the INFRASTRUCTURE repo's commit, so it never proves this
repo's merge: the running pod's image tag does.

## Cluster identity (read-only)

Four repo secrets, all set by the platform's publisher:

| Secret | Holds |
|---|---|
| `DEVELOPERZ_LIVE_CHECK_SSH_KEY` | the SSH private key for the forwarding-only bastion account |
| `DEVELOPERZ_LIVE_CHECK_KUBECONFIG` | kubeconfig for ServiceAccount `dz-live-check`, server `https://127.0.0.1:26443` |
| `DEVELOPERZ_LIVE_CHECK_SSH_KNOWN_HOSTS` | the bastion's pinned `known_hosts` line; its first field is the SSH host |
| `DEVELOPERZ_LIVE_CHECK_API_TARGETS` | the k3s API `host:port` targets the tunnel forwards to, space-separated, in failover order |

This guide names no host, host key or address: the recipe reads every one from those secrets,
so never write one into it. An unset secret is `cannot_grade`, naming it. The bastion account
can forward to the k3s API and do nothing else (no shell). If the tunnel or `/readyz` fails
with every secret set, the published values are stale: `cannot_grade`, naming the step that
failed; the source of truth is the infrastructure repository's
`stacks/platform/dz-live-check/README.md`. Needs `ssh` and `kubectl` on the box; without them
the check is `cannot_grade`, naming the missing tool.

```bash
for v in DEVELOPERZ_LIVE_CHECK_SSH_KEY DEVELOPERZ_LIVE_CHECK_KUBECONFIG \
  DEVELOPERZ_LIVE_CHECK_SSH_KNOWN_HOSTS DEVELOPERZ_LIVE_CHECK_API_TARGETS; do
  [ -n "${!v:-}" ] || echo "cannot_grade: $v is unset"
done
d="$HOME/.cache/developerz-live-check"; umask 077; mkdir -p "$d"
printf '%s\n' "$DEVELOPERZ_LIVE_CHECK_SSH_KEY" >"$d/id"
printf '%s\n' "$DEVELOPERZ_LIVE_CHECK_KUBECONFIG" >"$d/kubeconfig"
printf '%s\n' "$DEVELOPERZ_LIVE_CHECK_SSH_KNOWN_HOSTS" >"$d/known_hosts"
bastion="dz-live-check@$(head -n1 "$d/known_hosts" | cut -d' ' -f1)"
export KUBECONFIG="$d/kubeconfig"
# The control socket is under /tmp, not "$d": a unix socket path is capped at 108 bytes and
# $HOME can be long. %C is ssh's own hash of the connection. The trap closes the tunnel, which
# removes the socket, when this shell exits: run the proof below in this same shell.
ctl="/tmp/dz-lc-%C"
trap 'ssh -S "$ctl" -O exit "$bastion" 2>/dev/null' EXIT
for t in $DEVELOPERZ_LIVE_CHECK_API_TARGETS; do
  ssh -f -N -M -S "$ctl" -o BatchMode=yes -o IdentitiesOnly=yes -i "$d/id" \
    -o UserKnownHostsFile="$d/known_hosts" -o StrictHostKeyChecking=yes \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 \
    -L "127.0.0.1:26443:$t" "$bastion" \
  && kubectl --request-timeout=5s get --raw /readyz >/dev/null && break
  ssh -S "$ctl" -O exit "$bastion" 2>/dev/null
done
```

What it may read: pods, pod logs, deployments, replicasets, statefulsets, services, events and
ingresses (Traefik IngressRoutes too) in `ultimate-social`, and ArgoCD Applications. Everything else answers
`Forbidden`: secrets, configmaps, `exec`, `port-forward`, any write, any other namespace. A
step that needs one of those is `cannot_grade`, naming the step; never reach for another
credential.

## What runs where

| Namespace | Deployment | Image |
|---|---|---|
| `ultimate-social` | `ultimate-social-web` | `ultimate-social` |
| `ultimate-social` | `ultimate-social-worker` | `ultimate-social` |
| `ultimate-social` | `ultimate-social-scheduler` | `ultimate-social` |
| `ultimate-social` | `ultimate-social-sync` | `ultimate-social` |
| `ultimate-social` | `ultimate-social-replicator` | `ultimate-social` |

## Proof, in order

1. **The running image.**

   ```bash
   kubectl -n ultimate-social get pods -o jsonpath='{range .items[*]}{.metadata.name} {.spec.containers[*].image} {.status.phase}{"\n"}{end}'
   ```

   Deployed when every pod of each image the change touches is `Running` on
   `sha-<short>` of the merge commit or a later commit of `main`
   (`git merge-base --is-ancestor <merge> <short>`; `git fetch --unshallow` first on a
   shallow checkout). An image the change does not touch may still run an older tag.
   An older tag means the rollout has not landed: poll at most 10 minutes, then `fail`
   naming each Deployment and the tag it runs. `kubectl -n <ns> get events
   --sort-by=.lastTimestamp` and `kubectl -n <ns> logs deploy/<name>` say why a rollout is
   stuck.
2. **The real thing.** Probe what the change's `## Live test` names on the public URL and
   read the body, never only the status. The hosts are in the Traefik IngressRoutes'
   `Host(...)` matches:

   ```bash
   kubectl -n ultimate-social get ingressroutes.traefik.io -o jsonpath='{range .items[*]}{.spec.routes[*].match}{"\n"}{end}'
   ```

3. **Secondary only.** `Synced Healthy` from

   ```bash
   kubectl -n argocd get application ultimate-social -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
   ```

   is a second witness; its revision is the infrastructure repo's, not this one.

Docs-only, tests-only and CI-only changes deploy nothing. Say so; do not invent a probe.
