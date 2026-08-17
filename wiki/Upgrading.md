# Upgrading

**v1.1.0 `As of 2026-08`. Semver applies from here.** A breaking change to a documented API needs a major. Every `@ultimat3/*` version is pinned exactly and moves in lockstep — never mix versions.

## What semver covers

| Surface | From |
|---|---|
| `X_*` error codes | already stable forever — a shipped code never changes meaning and is never reused |
| The eight primitive shapes | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` and their declared fields — 1.0.0 |
| The `x` CLI surface | commands, flags, exit codes, and `--json` output shape — 1.0.0 |
| The import tier table | which package may import which — 1.0.0 |
| `app.config.ts` field names | renaming or removing a field is a major — 1.0.0 |

| Bump | Means | Examples |
|---|---|---|
| **major** | a covered surface changed incompatibly | a removed config field, a renamed CLI flag, a changed primitive field, a narrowed tier |
| **minor** | additive, old code still compiles and still passes `x verify` | a new optional field, a new command, a new driver behind an existing interface |
| **patch** | no surface change | a bug fix, a perf change, a corrected `fix:` line |

1.0.0 means a stable API under semver. It is not a claim about your infrastructure.

## Release policy

| Rule | Detail |
|---|---|
| Pinned exact versions | no `^`, no `~`, in the framework or in a generated app. A range is a silent upgrade |
| Lockstep releases | one release bumps all 29 packages — 28 `@ultimat3/*` plus the unscoped `create-ultimate` — to the same version. One version, one commit, one tag. A mixed set is unsupported |
| Published with provenance | npm via OIDC trusted publishing |
| Breaking changes land with codemods | if `x upgrade` cannot codemod it, the changelog carries the manual step |
| Dependency upgrades are framework work | SolidJS 2 is pre-1.0-stable in places. Bumping it is a framework release, never an app-level `bun update`. There is no ArkType or Drizzle pin to carry: `@ultimat3/schema` ships dependency-free builtin validators (ArkType is an optional provider you adapt yourself) and `@ultimat3/entity` ships its own `postgresDriver()` |
| Bun floor | `>=1.3`, target 2.0. Below the floor → `X_BUN_VERSION` |
| Deferred to v2, behind the interfaces that ship today | realtime tier 3 (`persist: true`, local-first), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — the last throw `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

Do not upgrade a transitive dependency of a `@ultimat3/*` package by hand. Open an issue instead — the pin is deliberate.

## `x upgrade` — **planned, not shipped**

`As of 2026-08` this command exits `X_NOT_IMPLEMENTED` ([`packages/cli/src/cmd-planned.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-planned.ts)). Its own `fix:` line names what to run instead, and that is the upgrade path today:

```
bun update --latest && x verify     # the shipped path
```

Everything the manual path skips, you do yourself: bump every `@ultimat3/*` pin to **one** exact version, then `x manifest` and `x verify`. There are no codemods to run, because no release has shipped one yet.

The design below is what the command will do, kept here because the **classes of breakage it automates are real today** and the next section is how each one is detected with or without it.

| # | Step | Detail |
|---|---|---|
| 1 | Resolve the target release | all `@ultimat3/*` at one version; refuses a partial set |
| 2 | Bump `package.json` pins | every workspace, exact versions |
| 3 | Run codemods | per-release, idempotent, AST-based. Each prints the files it touched |
| 4 | Regenerate `x.manifest.json` | routes, entities, actions, jobs, policies, tags, budgets |
| 5 | Regenerate `openapi.json` | HTTP surface from action/query declarations |
| 6 | Run `x verify` | the gate. Not green = the upgrade is not done |

`--dry-run`, once it exists, performs 1, 3 (in-memory), and reports the diff without writing. Output carries every changed file, every codemod name, and every check that would fail.

## Breaking-change classes and how each is detected

Nothing here relies on you reading a changelog carefully. Each class is a build error.

| Class | Detected by | Code | Fix |
|---|---|---|---|
| Action/query contract change | `x verify`'s `contract-diff` step, against the committed `x.manifest.json` | `X_MANIFEST_BREAKING` | `x verify --json` to read the finding, then bump the major version or restore the input/output shape |
| Breaking published surface | manifest contract diff, breaking subset | `X_MANIFEST_BREAKING` | bump the app's major version; old clients keep the old shape |
| Schema vs migrations | schema introspection vs migration history | `X_DB_DRIFT` | `x db gen "<message>"` then `x db migrate` |
| Stale generated facts | manifest freshness check | `X_MANIFEST_STALE` | `x manifest` |
| Import-tier change | `scripts/boundaries.ts` re-run over the new tier table | `X_BOUNDARY_VIOLATION` | move the import down a tier or invert the dependency |
| Budget ratchet | a release lowering a default budget | `X_BUDGET_EXCEEDED` | fix the regression, or set an explicit `budget` on the route |
| Config field rename/removal | config schema parse, and the compiler before it — an unknown key is an excess property on `Input<AppConfig>`, so it fails `typecheck` rather than reaching a runtime parse | `X_CONFIG_INVALID` | the cause names the field. No codemod has shipped yet, so this is a manual edit |
| Env schema change | typed env parse at boot | `X_ENV_MISSING` | add the key; fails in ~40ms, not as a later 500 |
| Renamed job step | duplicate/unknown step names in one `run` | `X_JOB_DUPLICATE_STEP` | renaming a step invalidates its stored result — treat as a new step |

Budgets ratchet **down** across releases. That is intentional: a framework release that makes bundles smaller should not leave your app's slack unclaimed.

## Version skew during a deploy

A client running build `A` requesting an asset from build `B` is the failure mode that actually breaks PWAs — not caching strategy.

| Mechanism | Behavior |
|---|---|
| Immutable build ID | content hash of the build, stamped into `sw.js`, the HTML, every asset path, and `x.manifest.json`. Never a timestamp, never `latest` |
| Client sends its build ID | `X-Ultimate-Build` on RPC, query, and WS handshake — so the server answers "you are stale" instead of guessing |
| N-deploy asset retention | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A count of deploys, with **no time component**: there is no 7-day half, and **no `pwa.retention` field** — `PwaConfig` is `{ enabled, offline, installPrompt, backgroundSync, push }`. Pass `keep` at the call site to hold more |
| `AppUpdateAvailable` signal | a Solid signal flips when the server reports a newer build. Your app renders its own "Update available — reload". No forced navigation, no lost form state |
| `x deploy --critical` | sets a forced-reload deadline. Client shows a countdown, drains in-flight state through the mutator queue, then reloads. Grace default 30m |
| Skew is observable | the `/_x` live panel reports the build-ID distribution of connected clients. `x status --json` is **planned**, not shipped |

Server behavior on a stale build ID:

| Request | Response |
|---|---|
| Asset within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; the SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; otherwise `X_BUILD_SKEW` with a `fix:` line |
| WS handshake | accepted, then an `update-available` frame carrying the server's `buildId` → signal flips. The socket is **not** killed |

Full detail: [PWA and offline](PWA-And-Offline).

## Migrating jobs between drivers — **v2**

`jobs.driver` accepts **`postgres` \| `redis` \| `nats`**, and `postgres` is the only one implemented — `redis` and `nats` are interface-complete stubs that throw `X_NOT_IMPLEMENTED`. So **there is no driver migration to perform** `As of 2026-08`: `x jobs drain --to redis` constructs the target and fails on its first enqueue.

`memory` is **not** a `jobs.driver` value and does not typecheck as one. It is a real driver reachable two other ways: `--to memory` (one of `x jobs drain`'s three targets) and `setJobDriver(createMemoryDriver())` at boot, which is what tests use.

`x jobs drain --to memory` works today, and it is the same command, so the procedure below is written against the interface that already ships and applies unchanged the moment a driver does:

| Order | Step |
|---|---|
| 1 | deploy with the old driver still configured |
| 2 | `x jobs drain --to <driver> --dry-run --json` — read the plan; a skipped candidate is a job whose `runAt` has not arrived, not an error |
| 3 | `x jobs drain --to <driver>` — leases the batch off the old queue, copies steps, enqueues, then acks |
| 4 | flip `jobs.driver` in `app.config.ts`, `x verify`, deploy |
| 5 | confirm with `x jobs ls --json` that the old queue is empty before removing its infra |

Job code never changes across a driver: `steps` is a driver member, so step persistence is identical on all of them. The outbox table stays the transactional record. At-least-once delivery is preserved; atomicity is not negotiable ([Jobs and workflows](Jobs-And-Workflows)).

## Migrating realtime tiers

| From → to | Change | Notes |
|---|---|---|
| tier 1 → tier 2 | `live: true` on the query | needs a `replicator` role and `orderBy` + `limit` on the `sql` |
| tier 2 → tier 3 | `persist: true` on the query | v2. No new mutators, no new authz, no new server code |
| `memory` → `nats` transport | `realtime.transport`, and **`realtime.urlEnv`** — the env *key name*, not a URL. There is no `realtime.url` field | roll `sync` and `replicator`; clients reconnect with server-directed backoff. What actually decides the transport at boot is **`NATS_URL` being set**: `selectTransport(env)` never reads `config.realtime.transport`, so the config field documents intent and the env var makes the switch ([Configuration](Configuration)) |

## Where the facts live

| Source | Contents |
|---|---|
| [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) | Keep a Changelog format. `Added` / `Changed` / `Removed`, plus a **Migration** block per breaking change with the codemod name |
| [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) | the twelve milestones, 0–10 shipped. Milestone 11's two-platform deploy proof is the one item still open |
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
