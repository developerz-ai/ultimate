---
description: Set up, run, or debug this app's deployment. Reads the current state before changing anything.
argument-hint: [setup | status | debug <symptom>]
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

$ARGUMENTS

**This app deploys anywhere a container runs.** The framework ships zero platform primitives: one
image, and `ROLE` selects `web | sync | worker | scheduler | migrate`. Compose, Kubernetes, Nomad,
a PaaS, one VM — the artifact is the same, and nothing below is specific to a vendor.

**Read the target before you assume it.** Look for `docker/`, a compose file, a chart, CI workflows,
or a sibling infrastructure repo, and say which one this app actually uses before touching anything.
Do not port a deployment style from another project because you have seen it before.

Two shapes you will meet, and the difference that matters:

| Shape | How a new version ships | Rollback |
|---|---|---|
| **push** — CI holds credentials and applies the change | CI runs the deploy step | re-run with the previous tag |
| **pull / GitOps** — CI holds none; the cluster watches a registry | CI pushes an image; a controller notices and syncs | pausing the controller, **not** `kubectl rollout undo` — it re-applies within minutes |

In a pull setup the handoff between repo and cluster is *an image digest*, and the **tag format is
the contract**: if CI stops emitting the tag the controller matches, deployment silently freezes on
the old digest and nothing reports an error.

## `setup`

1. **DNS first.** The TLS certificate is issued over HTTP-01, which cannot succeed until the
   hostname already resolves to the ingress node. Create the record, verify with `dig +short`, and
   only then merge anything.
2. **Datastores.** Provision the database, the cache and the object-storage bucket with the
   platform's own scripts — never by hand, never by copying another app's credentials. A secret is
   sealed to a specific `{namespace, name}` pair; copying the ciphertext produces a pod stuck in
   `CreateContainerConfigError`, not an error message.
3. **The image must exist before the manifests mean anything.** Tag format is the contract: if CI
   stops emitting the tag the updater matches, deployment silently freezes on the old digest and
   nothing reports an error.
4. **Health endpoints.** `/healthz` for liveness, `/readyz` for readiness, on `$PORT`. Note that a
   non-`web` role serves neither — probe its metrics port instead, or a healthy worker CrashLoops.
5. **Render-check locally before pushing**, and paste the output in the PR.

## `status`

Report, as a table: does DNS resolve; is the certificate issued; what digest is the cluster
running; how does that compare to the newest pushed tag; are pods ready; is the app answering over
HTTPS. **Verify with a live probe** — `curl` the real URL, or read the build id the running app
reports. Never grep a bundle to decide what shipped; never conclude "deployed" from a green CI run.

## `debug <symptom>`

Read the state before changing it. Match the symptom first:

| Symptom | First thing to check |
|---|---|
| certificate stuck pending | DNS did not resolve before the certificate was created |
| `ImagePullBackOff` | the pull secret is missing, or sealed for a different namespace |
| `CreateContainerConfigError` | a referenced secret key does not exist — often a cross-namespace secret that was never mirrored |
| pod `Pending` | the node is out of memory; check what the requests actually are |
| a new version never ships | the image tag stopped matching the updater's pattern |
| autoscaler reads `<unknown>` | no scrape target for the metrics port |

Rollback is **not** `kubectl rollout undo` — the updater re-applies within minutes. Pause the
updater for that app through the normal merge path first.

## Rules

- Never commit a secret. Encrypt it, or seal it, or reference it — the ciphertext is what lives in
  git.
- One stack per PR, and the PR body carries the exact commands that prove it is live.
- **Done means deployed and verified**, never "the manifests are merged".
