# Runbooks

Every entry here exists because it happened to an operator running this stack in production
(`As of 2026-08`). Generalised: no cluster-specific names, no assumption you use the same tools.

## Which levers actually stick

Read this table **before** you touch anything in a GitOps cluster. Most live edits are reverted by a
parent controller within minutes, and you will spend the outage arguing with a reconciler.

| You edit, live | Reverted by | Sticks? |
|---|---|---|
| the image reference on a child app object | the parent app-of-apps | **yes**, but only if the parent ignores that path *and* respects its own ignore rules |
| an **annotation** on a child app object | the parent's self-heal, ~3 min | **no** — pausing must be done in git |
| `kubectl scale` on a controller the GitOps tool manages | that controller's own app self-heal | **no** |
| the apex app-of-apps itself | nothing — it has no parent | **yes** — this is the global break-glass |

A corollary worth internalising: **plain `ignoreDifferences` is display-only.** Without
`RespectIgnoreDifferences=true` in the sync options, self-heal still reverts the field you thought
you had excluded.

## Roll back a bad image

**Pause the image watcher first. This is not optional.** A controller tracking a moving tag
re-resolves it every poll (~2 min) and re-applies the newest digest, overriding your rollback. Set an
old digest while it is still watching and the bad one is back before you have finished verifying.

| # | Step |
|---|---|
| 1 | Find the known-good digest: the app object's sync history, cross-checked against the watcher's own log lines, authoritatively against the registry's per-commit tag |
| 2 | **Pause in git** — comment out the watch annotation, open a PR, merge. A live `kubectl annotate` does not hold |
| 3 | Set the known-good digest on the live app object. Multi-image apps need *every* entry in the array, not just the broken one |
| 4 | Force a refresh, then verify: sync status, health status, and the pods' actual image references |
| 5 | Smoke-test through the ingress against a real route. A healthy status is reachability, not correctness |
| 6 | **Fix forward.** Push a corrected image so the moving tag points at a good digest, *then* un-pause. Un-pausing while the tag still points at the bad image re-applies it within minutes |

While the pause PR is in review, step 3 is a valid holding action — re-run it each poll until the
pause merges.

**Global break-glass**, in this order: suspend the apex app (no parent, so it holds) → suspend the
watcher's own app (now the apex will not restore it) → scale the watcher to zero. Resume in reverse.

## An app is stuck and nobody noticed

The nastiest deploy failure: every controller healthy, every build green, and one app silently
serving weeks-old code.

| Symptom | Cause |
|---|---|
| App sits `OutOfSync` but reports `Healthy` | often benign server-side diffs — this is why "alert on OutOfSync" alone gets muted on day one and then covers nothing |
| App is `OutOfSync` **and not** `Healthy`, with auto-sync on | a sync-wave hook failed. A failed pre-sync Job blocks **every later wave**, so Deployments are never applied at all |
| App is `Unknown` | the tool cannot even compare desired against live — repo unreachable, or the manifests fail to render |

Do this:

1. Read the app's last operation message. A failed migration Job is the most common cause, and it
   names itself.
2. Fix the cause, not the symptom. Deleting the failed Job re-runs it and it fails again.
3. Alert on it so next time is minutes, not weeks:
   `max by (name, namespace) (app_info{sync_status=~"OutOfSync|Unknown", health_status!="Healthy", autosync="true"}) == 1` for 30m.
   The `health_status != "Healthy"` clause is load-bearing, and the `max by` aggregation is what
   stops label churn from resetting the `for` clock — see [`03-observability.md`](./03-observability.md).

## `ImagePullBackOff`

Usually terminal, occasionally not.

| Cause | Self-heals? |
|---|---|
| A digest that no longer exists — pruned, or never pushed | no |
| A dead or missing pull secret | no |
| Cold-start race: pods scheduled before the namespace's pull secret was unsealed | yes, ~1 min |
| Registry 5xx or rate limit | yes, minutes |

So alert with grace, not on the first sample: `max_over_time(...[5m]) == 1` for `10m`, which is
about five minutes of *sustained* failure. Do not drop the smoothing — each kubelet retry cycles the
waiting reason through `ContainerCreating`, both matched series vanish, and a raw expression resets
its clock on every retry and therefore never fires.

Check, in order: does the pinned digest still exist in the registry; is the namespace's pull secret
valid *and sealed for this namespace*; is the registry up.

## Deploys went quiet

With in-cluster image promotion there is **no git artifact** when it stalls — nothing to notice. Two
safety nets, neither of which needs a new scrape target:

| Alert | Expression |
|---|---|
| The image watcher is down | `kube_deployment_status_replicas_available{deployment="<watcher>"} == 0 or absent(...)`, for 15m |
| The GitOps controller is down | `up{job="<gitops-metrics>"} == 0`, for 10m — it is what turns a patch into an actual rollout |

Deliberately pausing the watcher by scaling it to zero trips the first one. Silence it for the
window, or pause per-app instead so the controller keeps running.

## Registry pruning ate the rollback target

Retention policy that works: protect the floating aliases by name (`latest`, `main`, `stable`,
`prod`), keep the newest N build tags by timestamp, delete the rest. Prune per-deploy, with a
scheduled sweep as the backstop for repos that have not adopted the per-deploy hook.

**Your effective rollback window is exactly `N`.** With `keep 2` you can roll back two deploys, worst
case. Rolling back is digest-based and does not need the *tag* to still exist — but it does need the
*manifest*, and garbage collection reclaims it minutes after the tag goes.

There is **no API to undelete a tag** in any major registry. Recovery is re-pushing from CI, which
produces a new digest with no continuity to the old one. If a bad push just landed and you suspect
another deploy is imminent, **pause the watcher before you do anything else**.

## Nobody was paged

Work outward from the alert:

| Check | How |
|---|---|
| Did the rule fire? | the alerting UI — if not, the expression is wrong or the metric name never existed |
| Did it route? | one unresolvable secret reference drops the **whole** routing-config object, leaving only the null receiver |
| Was it suppressed? | list alerts with `state=suppressed` and read `inhibitedBy`. An inhibition source that cannot self-clear is a permanent cluster-wide mute |
| Did delivery fail? | `alertmanager_notifications_failed_total` — and check that *this* alert routes over a path independent of the thing that is broken |
| Was the whole cluster down? | nothing in-cluster can page. This is what the off-cluster dead-man exists for |

Then fix the class, not the instance. Each row above corresponds to a countermeasure in
[`03-observability.md`](./03-observability.md).

## A migration failed mid-deploy

| Situation | Do |
|---|---|
| The migrate Job failed, no serving pod started | the old version is still serving. Fix the migration and re-deploy. **Do not** roll the image back past the migration — the schema may already be partly applied |
| The migration succeeded, the new code is broken | roll the image back. This is safe **only** if the migration was additive. If it dropped or renamed anything, the old code cannot run against the new schema, and the rollback is a second outage |
| The migration is stuck holding a lock | find the blocking session; the `migrate` role runs with no statement timeout by design, so it will wait forever rather than fail |

The rule that prevents the middle row is in [`01-kubernetes.md`](./01-kubernetes.md): **expand in one
release, contract in the next.** It is a review blocker, not a runbook step, because by the time you
are reading a runbook it is already too late.

## A credential leaked

| # | Step |
|---|---|
| 1 | **Contain before investigating.** Remove the access path — drop the key, deactivate the identity, scale a compromised workload to zero **in git** so the reconciler does not restore it |
| 2 | **Coordinate before rotating anything shared.** A blind rotation invalidates every copy at once, including legitimate consumers. Announce, pick a window, migrate dependents, then rotate |
| 3 | Enumerate the real blast radius by sweeping **live** Secret values, not the repo. Sealed ciphertext is namespace-scoped, so identical plaintext seals to different blobs and a git diff proves nothing |
| 4 | Re-seal everything the leaked identity could read |
| 5 | Remove the structural cause: a bind-mounted token, a shared service account, a personal credential doing a service credential's job |
| 6 | Write the postmortem — see [`05-disaster-recovery.md`](./05-disaster-recovery.md) |

Two priors worth holding: a **personal** credential used as a **service** credential is the most
common root cause, and a credential that lives as a plain file on a host appears in **no** manifest
audit — which is exactly why it goes unnoticed.

## A node went `NotReady`

Before you touch the node, confirm it is actually down. A blocked scrape path presents identically
to a dead node if your alert is sourced from a scrape rather than from the node controller — and an
alert that cannot self-clear turns its inhibition rule into a fleet-wide mute. Check node readiness
via the API server, then the kubelet, then the network path, in that order.

If it is genuinely down: workloads with `nodeAffinity` pinned to that node **will not reschedule**.
That is the cost of pinning, and it is the right trade for a database on a node-local volume — and
the wrong one for a stateless role.
