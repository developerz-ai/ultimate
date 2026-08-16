# Secrets

The only secret-bearing file in git is **ciphertext**. Plaintext never lands in a repo, a shell
history, a CI log, or an agent transcript.

Ultimate takes secrets as environment variables and validates them at boot against the typed env
schema — it has no opinion about where they came from. That makes this an operator choice, and the
choice below is the one an operator running this stack in production made (`As of 2026-08`).

## Pick one

| Approach | Use when | Cost |
|---|---|---|
| **Sealed secrets** (an in-cluster controller holding an asymmetric keypair) | you own the cluster and want the encrypted value reviewable in a PR | one controller, one key to back up, one key whose loss is unrecoverable |
| **An external secret operator** pulling from a managed vault | you already pay for a vault, or compliance wants an audit trail per read | a live dependency between the vault and every pod start |
| **Your platform's secret store** | rungs 0–2 — a PaaS or a single box with a `.env` file `chmod 600` | no review trail; rotation is manual |

The rest of this doc documents the first, because it is the one with real scar tissue attached.

## Why sealed secrets work

The controller holds a keypair:

| Half | Role | Visibility |
|---|---|---|
| Public certificate | encrypts | safe to publish — commit it next to the manifests |
| Private key | decrypts | **never leaves the cluster** |

So anyone can seal, from anywhere, with no cluster access, no kubeconfig and no VPN. Only the
controller can unseal, and only after the GitOps controller has applied the object. A `SealedSecret`
in a cloned repo is inert.

**Strict scoping is the feature and the footgun.** The ciphertext is cryptographically bound to the
exact `{namespace, name}` of the target Secret. Sealed for the wrong namespace, it simply will not
decrypt — a leaked blob cannot be replayed into a namespace you control, and a typo produces silence
rather than an error.

## The workflow

```sh
# 1. write the raw Secret locally. --dry-run=client is fully client-side: no cluster contact.
kubectl create secret generic <app>-secrets --namespace=<app> \
  --dry-run=client -o yaml \
  --from-file=DATABASE_URL=./secrets/database-url \
  --from-file=AUTH_SECRET=./secrets/auth-secret \
  > raw.yml

# 2. seal against the committed public certificate — works offline, anywhere.
kubeseal --cert ./platform/sealed-secrets/cert.pem --format yaml \
  < raw.yml > apps/<app>/manifests/sealed-secret.yml

# 3. destroy the plaintext, immediately.
shred -u raw.yml
```

`--from-file` rather than `--from-literal`: a literal puts the secret in your shell history and in
the process table. Read from a file, then shred the file.

Wire the result into the Deployment with `envFrom.secretRef` — the shipped Helm chart already does,
via `existingSecret` in [`values.yaml`](../../docker/helm/values.yaml):

```yaml
existingSecret: ultimate-secrets   # DATABASE_URL, NATS_URL, S3_*, AUTH_SECRET
```

so the sealed Secret must be named `ultimate-secrets` in the release namespace, or the value must
be changed to match. The controller decrypts the `SealedSecret` into a plain `Secret` of that name;
the pod never knows the difference.

## Footguns

| Footgun | Symptom | Fix |
|---|---|---|
| Sealed for the wrong `name` or `namespace` | Nothing. The Secret never appears; the pod fails `CreateContainerConfigError` on a missing env var | triple-check `metadata.name` and `metadata.namespace` against what the Deployment consumes |
| Renamed the app's namespace | Every `SealedSecret` in it is now undecryptable | re-seal all of them |
| Re-sealed a value, pod still has the old one | A Secret change does not restart a pod | run a reload controller that rolls the Deployment on Secret change, and exclude its pod-template annotation from GitOps self-heal — see [`01-kubernetes.md`](./01-kubernetes.md) |
| The registry pull secret is one `SealedSecret` reused across namespaces | It only decrypts in the one it was sealed for | re-seal it per namespace |
| The committed public cert is stale after a key rotation | Nothing, usually — the controller retains retired keys for decrypt | refresh the committed cert when you want it honest, not because a seal is broken |
| A `PRIVATE KEY` block appears where a certificate was expected | Something has gone badly wrong | stop; do not commit; the fetch tooling should refuse to write that payload at all |

## Rules that keep the blast radius small

**One credential per consumer.** An operator running this stack measured a single object-store access
key shared byte-identically across nine cluster Secrets — three observability backends, three backup
jobs and three production apps. One host compromise would have handed over all nine, and because the
same key backed the backup jobs' own delete calls, the thief could have destroyed the recovery floor
rather than merely reading it. It was found by sweeping every value of every Secret in the cluster,
not by reading the repo: sealed ciphertext is namespace-scoped, so identical plaintext necessarily
seals to *different* blobs. **You cannot detect credential sharing from a git diff.** Only a live
comparison finds it.

**Never treat a personal credential as a service credential.** The same operator lost a day to an
incident where one human's AI-tool OAuth token had been copied onto shared machines and bind-mounted
into agent containers, because that was the cheapest way to give an agent a working session. Two
symptoms, one cause: agents ran as the wrong identity, and the wrong person's quota was consumed. The
fix is structural — unattended agents get a scoped, rotatable credential of their own; interactive
users authenticate as themselves; nothing ever copies a token file between machines.

**Give every agent its own identity.** One login user per handle, key-only, with the authorized-key
file rewritten authoritatively on every sync so a rotated-out key is *removed* rather than merely
superseded. That is what lets you revoke one agent without touching anyone else, and what makes the
audit log mean something.

**Revoke on event, not on a timer.** A rotation cron is theatre if access is not actually removed
when a person or an agent leaves. Drop the key, deactivate the identity, re-seal anything that
identity could read — in that order.

## The one unrecoverable secret

The controller's private key decrypts every `SealedSecret` you have ever committed. Lose it and the
repo is a directory of undecryptable blobs: the cluster is **not** rebuildable from git, and every
secret has to be re-created by hand.

Back it up, off-cluster, encrypted, on a schedule — and prove the restore works before you need it.
That is [`05-disaster-recovery.md`](./05-disaster-recovery.md), and it is not optional.
