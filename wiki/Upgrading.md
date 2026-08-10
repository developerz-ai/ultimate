# Upgrading

`As of 2026-07`: pre-v1. **No semver promise, no published npm packages, no stability guarantee.** Every `@ultimat3/*` version is pinned exactly and moves in lockstep. Anything below can change until v1.

## Pre-v1 policy

| Rule | Detail |
|---|---|
| Pinned exact versions | no `^`, no `~`, in the framework or in a generated app. A range is a silent upgrade |
| Lockstep releases | one release bumps every `@ultimat3/*` package to the same version. A mixed set is unsupported |
| Breaking changes land with codemods | if `x upgrade` cannot codemod it, the changelog carries the manual step |
| Dependency upgrades are framework work | ArkType, Drizzle, and SolidJS 2 are pre-1.0-stable in places. Bumping them is a framework release, never an app-level `bun update` |
| Bun floor | `>=1.3`, target 2.0. Below the floor → `X_BUN_VERSION` |
| Milestone order is the release order | milestones 0–5 ship before realtime; tiers 1–2 in v1; tier 3 (local-first) in v2 |

Do not upgrade a transitive dependency of a `@ultimat3/*` package by hand. Open an issue instead — the pin is deliberate.

## `x upgrade`

```
x upgrade --dry-run --json     # what would change, machine-readable
x upgrade                      # apply
```

Ordered steps. A failure at any step stops and leaves the tree unchanged where possible.

| # | Step | Detail |
|---|---|---|
| 1 | Resolve the target release | all `@ultimat3/*` at one version; refuses a partial set |
| 2 | Bump `package.json` pins | every workspace, exact versions |
| 3 | Run codemods | per-release, idempotent, AST-based. Each prints the files it touched |
| 4 | Regenerate `x.manifest.json` | routes, entities, actions, jobs, policies, tags, budgets |
| 5 | Regenerate `openapi.json` | HTTP surface from action/query declarations |
| 6 | Run `x verify` | the gate. Not green = the upgrade is not done |

`--dry-run` performs 1, 3 (in-memory), and reports the diff without writing. Output carries every changed file, every codemod name, and every check that would fail.

## Breaking-change classes and how each is detected

Nothing here relies on you reading a changelog carefully. Each class is a build error.

| Class | Detected by | Code | Fix |
|---|---|---|---|
| Action/query contract change | `x verify`'s `contract-diff` step, against the committed `x.manifest.json` | `X_MANIFEST_BREAKING` | `x verify --json` to read the finding, then bump the major version or restore the input/output shape |
| Breaking published surface | manifest contract diff, breaking subset | `X_MANIFEST_BREAKING` | bump the app's major version; old clients keep the old shape |
| Schema vs migrations | schema introspection vs migration history | `X_DB_DRIFT` | `x db gen "<message>"` then `x db apply` |
| Stale generated facts | manifest freshness check | `X_MANIFEST_STALE` | `x manifest` |
| Import-tier change | `scripts/boundaries.ts` re-run over the new tier table | `X_BOUNDARY_VIOLATION` | move the import down a tier or invert the dependency |
| Budget ratchet | a release lowering a default budget | `X_BUDGET_EXCEEDED` | fix the regression, or set an explicit `budget` on the route |
| Config field rename/removal | config schema parse | `X_CONFIG_INVALID` | the codemod usually handles it; the cause names the field |
| Env schema change | typed env parse at boot | `X_ENV_MISSING` | add the key; fails in ~40ms, not as a later 500 |
| Renamed job step | duplicate/unknown step names in one `run` | `X_JOB_DUPLICATE_STEP` | renaming a step invalidates its stored result — treat as a new step |

Budgets ratchet **down** across releases. That is intentional: a framework release that makes bundles smaller should not leave your app's slack unclaimed.

## Version skew during a deploy

A client running build `A` requesting an asset from build `B` is the failure mode that actually breaks PWAs — not caching strategy.

| Mechanism | Behavior |
|---|---|
| Immutable build ID | content hash of the build, stamped into `sw.js`, the HTML, every asset path, and `x.manifest.json`. Never a timestamp, never `latest` |
| Client sends its build ID | `X-Ultimate-Build` on RPC, query, and WS handshake — so the server answers "you are stale" instead of guessing |
| N-deploy asset retention | old builds' assets stay served for **10 deploys or 7d, whichever is longer** (`pwa.retention` in [Configuration](Configuration)) |
| `AppUpdateAvailable` signal | a Solid signal flips when the server reports a newer build. Your app renders its own "Update available — reload". No forced navigation, no lost form state |
| `x deploy --critical` | sets a forced-reload deadline. Client shows a countdown, drains in-flight state through the mutator queue, then reloads. Grace default 30m |
| Skew is observable | `x status --json` reports the build-ID distribution of connected clients |

Server behavior on a stale build ID:

| Request | Response |
|---|---|
| Asset within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; the SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; otherwise `X_BUILD_SKEW` with a `fix:` line |
| WS handshake | accepted, then a `build-stale` frame → signal flips. The socket is **not** killed |

Full detail: [PWA and offline](PWA-And-Offline).

## Migrating jobs between drivers

Switching `jobs.driver` is a config line plus a migration of in-flight rows. Job code never changes — `saveStep` / `loadSteps` are driver methods, so step persistence works identically on all three drivers.

```
x jobs drain --to redis --json     # move in-flight rows, then flip the config
```

| Order | Step |
|---|---|
| 1 | deploy with the old driver still configured |
| 2 | `x jobs drain --to <driver>` — stops claiming from the old queue, relays committed outbox rows to the new one |
| 3 | flip `jobs.driver` in `app.config.ts`, `x verify`, deploy |
| 4 | confirm with `x jobs ls --json` that the old queue is empty before removing its infra |

The outbox table stays the transactional record on every driver. At-least-once delivery is preserved; atomicity is not negotiable ([Jobs and workflows](Jobs-And-Workflows)).

## Migrating realtime tiers

| From → to | Change | Notes |
|---|---|---|
| tier 1 → tier 2 | `live: true` on the query | needs a `replicator` role and `orderBy` + `limit` on the `sql` |
| tier 2 → tier 3 | `persist: true` on the query | v2. No new mutators, no new authz, no new server code |
| `memory` → `nats` transport | `realtime.transport` + `realtime.url` | roll `sync` and `replicator`; clients reconnect with server-directed backoff |

## Where the facts live

| Source | Contents |
|---|---|
| [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) | Keep a Changelog format. `Added` / `Changed` / `Removed`, plus a **Migration** block per breaking change with the codemod name |
| [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) | the 12 milestones. Each ends in a working demo app plus green `x verify` |
| [`docs/idea/15-risks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/15-risks.md) | what could still change shape — the sync engine is roughly 70% of total effort |
| `x.manifest.json` | generated, per build. Diff two manifests to see exactly what a release changed in your app |

Read the changelog **backwards from your current pin to the target**, and read the `Migration` blocks only — the rest is regenerated for you.

## When an upgrade fails

```
git revert <the upgrade commit>      # or redeploy the previous image tag
x verify --json > verify.json
```

| Situation | Do |
|---|---|
| Prod is already rolling | redeploy the previous image tag. Assets from the previous build are inside the retention window, so sessions survive |
| A codemod produced broken code | keep the diff. It is the most useful part of the bug report |
| `x verify` fails on one check | read that step's findings from `x verify --json`, then reproduce it with the command its `fix` names |
| Cause is unclear | `x errors explain <CODE> --json` |

File an issue with `verify.json` attached, your previous and target versions, and the codemod output. The JSON is the report — do not paraphrase the terminal.

Symptom-first fixes: [Troubleshooting](Troubleshooting). Code index: [Error codes](Error-Codes).
