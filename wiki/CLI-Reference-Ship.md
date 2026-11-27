# CLI reference: build, deploy and run

Part of the [CLI reference](CLI-Reference): `x build`, `x deploy`, production roles, `x secrets`, `x auth`, `x vapid`, `x status`, `x heavy`, `x config`. Conventions, global flags and the command index are on the index page.

## x build

```bash
x build --target docker|binary|static|prebuilt [--tag name] [--out path] [--platform bun-target] [--no-preflight] [--no-capture] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--target` | string | `docker` | `docker` (one image, all roles), `binary` (`bun build --compile`), `static` (prerendered `site/`), `prebuilt` (the island store and compiled stylesheets, written to `node_modules/.cache/ultimate` — the app image's own `RUN` line; no gate, no subprocess, refuses `--tag` and `--out`). The list is `BUILD_TARGETS` in `packages/cli/src/cmd-build.ts` |
| `--tag` | string | `ultimate-app:dev` | image tag, docker target only |
| `--out` | string | `.x/app` (`.x/static` for `static`) | output path, binary and static targets only; relative to the cwd |
| `--platform` | string | the host | binary target only: `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64` or `bun-darwin-arm64`, passed to Bun as `--target` (the list is `BINARY_PLATFORMS` in `packages/cli/src/cmd-build.ts`). A Windows executable — `--platform bun-windows-x64`, or no `--platform` on a Windows host — is written as `<out>.exe`, and `data.artifact` names that file; `data.platform` echoes the flag. Any other value is `X_CLI_BAD_FLAG` before the gate runs, `fix: x build --target binary --platform bun-linux-x64`. For local runs and CI cross-compiles: a Windows host deploys the Linux image under Docker Desktop ([Deployment](Deployment)). `As of 2026-10-05` |
| `--no-preflight` | boolean | off | skip the six static gate steps the build runs first (typecheck, lint, boundaries, filesize, package-shape, errors) — only when `x verify` has run them, as its `budgets` step does when it builds. Not on `prebuilt`. `As of 22.7` |
| `--no-capture` | boolean | off | `static` only: stamp every `og.capture` card's `og:image` tags and photograph none, so no browser is needed (`X_SEO_CARD_BROWSER_MISSING` otherwise). `x verify`'s own build and `scripts/reference-app-gate.ts` pass it, and only they do — a deployable build takes the pictures. Reaches the app's `prerender.ts` as `ULTIMATE_BUILD_CAPTURE=off`. `As of 2026-11` |

A flag the chosen target never reads — `--tag` on `binary`/`static`, `--out` on `docker`, `--platform` on anything but `binary`, any of them on `prebuilt` — is `X_CLI_BAD_FLAG` before the gate runs, with `fix: x build --target <target>`.

**`--out` for `static` is emptied before every build**, so it must be provably the build's: absent, empty, the default `.x/static`, or a directory holding the `.x-export` marker every static build writes. The app root, an ancestor of it, or any other non-empty directory (`apps`, `.x`, `.x/pgdata`, a home directory) is `X_BUILD_OUT_UNSAFE` and nothing is removed. A module that will not import fails the static build with `X_BUILD_FAILED` (`fix: x verify --only manifest --json`) before the export is touched — its page would otherwise vanish from the artifact under a green build.

### Every target has one entry file

`BUILD_ENTRY` is the whole mapping. The entry is checked **before** the verify gate runs and before the builder is spawned, because `bun build`'s own "module not found" names no owner.

| `--target` | Entry file | Command it execs | Output |
|---|---|---|---|
| `docker` | `docker/Dockerfile` | `docker build -f <root>/docker/Dockerfile -t <tag> <root>` | one OCI image, `ROLE` selects behaviour |
| `binary` | `apps/web/server.ts` | `bun build --compile --minify [--target <platform>] --define ULTIMATE_FRAMEWORK_VERSION="<version>" <root>/apps/web/server.ts --outfile <out>[.exe]` | a single executable |
| `static` | `apps/web/prerender.ts` | `bun run <root>/apps/web/prerender.ts --out <out>` | prerendered `site/` |

All three are written by `x new`. A missing one is `X_BUILD_ENTRY_MISSING`, whose `fix` names the file and points at a fresh scaffold — the usual cause is an app scaffolded before 1.1.0 wrote `server.ts` and `prerender.ts`, or a deleted `docker/Dockerfile`.

Runs the static verify steps first (`typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors`); if any fail, exits non-zero without building. The content-hash build ID every target shares is `x.manifest.json`'s, written by `x manifest`, not computed here. Errors: `X_BUILD_ENTRY_MISSING`, `X_BUILD_FAILED`, `X_BUILD_OUT_UNSAFE`, `X_CLI_BAD_FLAG`; an unknown `--target` is `X_CLI_UNKNOWN_COMMAND` with `build --target docker` as the suggestion.

### `--target static` names every route it emitted, and every one it did not

`.x/static/` is a **partial site**: `site/` routes declaring `render: 'static'` become files, and everything else is served by the app. Both renderers say so — `data.emitted` and `data.skipped` under `--json`, the same rows as a table in the terminal. A screenshot tool pointed at the directory used to photograph the landing page and file "the island did not mount" against a route that had never been in the artifact.

| Field | Row | Meaning |
|---|---|---|
| `emitted` | `{ route, path, file }` | one **file**, and the declared route that produced it — `/blog/:slug` writes one row per prerendered path |
| `skipped` | `{ route, surface, render, reason, why }` | one declared route that wrote nothing, and the cause |

**Every declared route is in exactly one of the two.** A route in neither is the defect this exists to close.

`reason` is a closed set, and the four are not one cause wearing four names — the surface is asked **first**, because `app/` allows only `stream | ssr` and no `render:` edit can put an `app/` route in the artifact:

| `reason` | Cause | Is there an edit? |
|---|---|---|
| `surface-forbids-static` | the surface cannot declare `render: 'static'` at all (`app/`) | no — move the route to `site/`, or serve it |
| `mode-revalidates` | `render: 'isr'` regenerates on a tag or ttl, which a published file cannot | yes — `render: 'static'` |
| `mode-per-request` | `render: 'ssr'` / `'stream'` on a surface that *does* allow static | yes — `render: 'static'` |
| `no-prerender-paths` | `render: 'static'` with dynamic params and no `prerender()`, so nothing enumerated | yes — add `prerender()` |

Both lists come from `prerenderSite`, which writes `.x/static-report.json` beside `.x/build-stats.json`; `x build` deletes any previous copy before it spawns the builder, so a stale inventory can never be reported as this run's. An app whose `apps/web/prerender.ts` does not call `prerenderSite` writes neither file, and `x verify`'s `budgets` step, which ran this build itself, reds it with `X_BUDGET_UNMEASURED`.

Budgets are unchanged and still measured in **real bytes on disk** — `measureDocumentJs` weighs every `<script src>` and every `data-x-entry` island chunk in the emitted document against the files in `out`, which is what catches one engine imported twice. A route that is skipped here is still weighed: it is rendered in memory and thrown away, so a `budget:` on an `ssr` or `isr` route has a number.

> `--target binary` compiles `apps/web/server.ts` as a **launcher** for the app tree it is started in: `--compile-autoload-package-json` and `--compile-autoload-tsconfig`, so the app's packages and `paths` aliases resolve at run time, and `--external '@ultimat3/*'`, so the framework is ONE instance — loaded from the app's `node_modules`, the same copy the app's own modules register into. It bundles neither the app nor the framework: run it from the app root, with `node_modules` installed beside it; it needs no Bun. It still passes `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, which only bundled framework code reads — none, in this graph; the framework's self-contained `x` image (`docker/Dockerfile`) is where the define is load-bearing. What is still unmeasured is the target end to end on a bare VM ([Known gaps](Known-Gaps)). `As of 2026-10-06`

## x deploy

```bash
x deploy --image repo/app:tag [--method compose|helm] [--release name] [--namespace ns] [--timeout 15m] [--dry-run] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--image` | string | `ultimate-app:dev` | image reference to deploy |
| `--method` | string | `compose` | `compose` or `helm` |
| `--release` | string | `app.config.ts`'s `name` | helm release name; `helm` only |
| `--namespace` | string | the kube context's | helm namespace; `helm` only |
| `--timeout` | string | `15m` | how long helm waits for the migrate hook and the rollout; `helm` only |
| `--dry-run` | boolean | `false` | print the plan, run nothing |

`compose` is six ordered steps against `docker/docker-compose.prod.yml` — `run --rm migrate` to
completion, then `up -d` for `web`, `sync`, `worker`, `scheduler`, then `run --rm backfill` last.
**`migrate` gates and `backfill` triggers**: a slow `UPDATE` inside a release gate holds the deploy
open against a database still serving the previous release, so data sweeps are enqueued after the
new pods serve and the workers already draining the queue perform them. The `backfill` service runs
`x db backfill --all --write --json` and exits. Steps run sequentially and stop
at the first non-zero exit; the `fix` is that step's command, so you can rerun it directly for full
output. `helm` is one `helm upgrade --install <release> docker/helm [--namespace <ns>] --wait
--timeout <timeout> --output json --set-string image.repository=… --set-string image.tag=…` against the chart
**`x new` writes**. **It waits**, `As of 2026-09-23`: without `--wait` the command exited 0 the
moment the API server accepted the objects, and helm's own 5m default failed an upgrade whose
migrate hook was still applying a long migration. `--json` reports helm's own verdict as
`data.rollout` — `{ release, namespace, revision, status }`, `status` being helm's word
(`deployed`, `failed`) or `unknown` when helm printed no record. The release was the literal `app`
for every app; it is now `app.config.ts`'s `name`, and `--release app` addresses a release an
earlier version created. `--release`, `--namespace` and `--timeout` on `--method compose` are
refused (`X_CLI_BAD_FLAG`), never ignored. There is no `X_NOT_IMPLEMENTED` branch: the command implements helm
completely, so an app that deleted its chart gets helm's own error and an app with no `helm` on
`PATH` gets `X_CLI_UNEXPECTED` naming the binary to install. An image pinned by digest is refused
before the upgrade starts — the chart renders `repository:tag` with no digest branch.

**An unknown `--method` is refused, never defaulted.** `x deploy --method helmm` is
`X_CLI_UNKNOWN_COMMAND` listing `compose, helm`; it used to run the six-step Compose plan and report
`method: "compose"` back to an operator who asked for a Helm upgrade.

**There is no `--critical` flag**, `As of 2026-08-23`. It was deleted; the parser answers
`X_CLI_BAD_FLAG` and lists the flags `deploy` does declare. It parsed, it was echoed into the
plan JSON as `critical: <bool>`, and no file in `packages/` read that field — so it changed nothing
about what the command did, on either method
([`packages/cli/src/cmd-deploy.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-deploy.ts)
says so where it used to be declared). It is not coming back: the framework force-reloads nothing
and no longer pretends to →
[`docs/architecture/13-topology-runtime.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/13-topology-runtime.md).
The flag list this build ships is `x help --json`, never this page.

Errors: `X_DEPLOY_FAILED` (a step exited non-zero — its `fix:` is that step's exact command),
`X_CLI_BAD_FLAG` (a digest-pinned `--image` under `--method helm`, a helm-only flag under
`--method compose`, a `--timeout` helm would reject, a `--release`/`--namespace` that is not a
DNS-1123 label, or a flag `deploy` does not declare), `X_CONFIG_INVALID` (`--method helm` with no
`--release` and an `app.config.ts` whose `name` is not a helm release name),
`X_CLI_UNKNOWN_COMMAND`, `X_CLI_UNEXPECTED`.

**`--method compose` reads `.env.production` before its first step** (`As of 30.0.0`): no file, or a
`${VAR:?}` of `docker/docker-compose.prod.yml` it leaves empty (and the shell does not set), is
`X_DEPLOY_ENV_MISSING` naming the variables, and nothing runs; `x env init --production` writes the
file. A failed step's `X_DEPLOY_FAILED` cause carries the container's own line — the last rendered
`X_*` refusal, read from the one-shot's output or the serving role's `docker compose logs`.

### x deploy verify

Does production serve this build, does it hold, and does a worker of this build claim every queue. A GitOps roll never runs `x deploy`; this runs in either case. HTTP and Postgres only. `As of 30.0.0`

```bash
x deploy verify --url <origin> [--build <id>] [--window 60s] [--interval 5s] [--timeout 10m] [--idle-ok <queue,…>] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--url` | string | required | a bare `http(s)` origin; a path, query or credentials are refused |
| `--build` | string | `x.manifest.json`'s `buildId` | the id that must answer: `BUILD_ID`, or whatever CI stamped |
| `--window` | string | `60s` | how long consecutive good samples must span. `0`: answered once |
| `--interval` | string | `5s` | the gap between samples |
| `--timeout` | string | `10m` | the whole wait, window and queues together |
| `--idle-ok` | string | none | queues exempt while their depth (due + running) is 0: a scale-to-zero pool |

| Stage | Rule |
|---|---|
| sample | `GET <origin>/readyz` on a new connection each, `cache-control: no-cache`, redirects refused. Good: 2xx, `x-ultimate-build` equals the build, and no `Age` above 0 (a CDN copy is not the fleet) |
| window | wait for the first good sample, then `--window` of consecutive good ones. A bad sample restarts it, and since the first good one fewer than one sample in `ceil(window / interval)` may be bad: a fleet stuck with old pods stays red |
| coverage | samples through the load balancer, reported as samples. **Never a claim about each pod** |
| queues | after the window, when `DATABASE_URL` is set. Expected: `jobs.queues` plus every registered job's queue. Served: a row not draining, of this build. Re-read until served or `--timeout`; a failed read keeps the last grade, and none landing is `X_DB_UNAVAILABLE` |
| no `DATABASE_URL` | `queues.graded: false` and the summary says so. Never the embedded database, never counted as a pass |

`--json` `data`: `{ build, samples: { total, good, byBuild, byStatus, share, cached }, windowMs, queues: { graded, served, unserved: [{ queue, builds, depth }], idle, containers? } }`. `byStatus` counts a sample nothing answered as `unreachable`. `builds` names what the workers claiming that queue run (`unknown` for a row from before 30.0.0), so a stalled roll reads as one. `containers` (`As of 2026-11-19`, present when the registry was read): `[{ host, processes, slots }]`, this build's serving worker rows grouped by `host`, sorted — a container running `ULTIMATE_PROCESSES=N` is one `host` with `processes: N`, and `slots` is its `jobs.concurrency` total however the children split it ([Deployment](Deployment#processes-per-container)).

Errors: `X_DEPLOY_BUILD_MISMATCH` (no sample carried the build), `X_DEPLOY_BUILD_UNSTAMPED` (2xx with no header, and no build ever named), `X_DEPLOY_UNSTABLE` (the build answered, the window never closed), `X_DEPLOY_QUEUE_UNSERVED` (one finding per queue), `X_CLI_BAD_FLAG`.

`X_MIGRATE_CONCURRENT` **is thrown**, `As of 2026-08`. `ROLE=migrate` takes the migration lock by a
**bounded** `pg_try_advisory_lock` poll on one pinned session — one try per 500ms against a 60s
budget (`MIGRATION_LOCK_WAIT_MS`) — and holds it for the whole run. Two overlapping deploys
therefore serialise while the first is merely slow: the second waits, then applies. A lock still
held when the budget runs out is `X_MIGRATE_CONCURRENT` and a non-zero exit, because blocking
`pg_advisory_lock` has no timeout and a wedged predecessor sat inside one statement with nothing in
the logs — that is what 1.2.0 does → [Known gaps](Known-Gaps).

## Serving in production — `ROLE`, `PORT` and `HOST`

There is no `x serve` command. A container runs the scaffolded `apps/web/server.ts`, which calls
`runRole({ root, env: Bun.env })` — the production boot path, with no dev watcher, no `/_x`, and
`dev: false`. It binds `0.0.0.0` unless `HOST` says otherwise, because a process bound to
loopback inside a container is unreachable from the port mapping, the load balancer and every
health probe at once.

| Env | Default | Meaning |
|---|---|---|
| `ROLE` | `web` | one of `web`, `sync`, `worker`, `scheduler`, `migrate`, `replicator`. **There is no `all`** |
| `PORT` | `3000` | empty or whitespace falls back to the default; anything else must be an integer in 0–65535 (`0` is legal — an ephemeral port) |
| `HOST` | `0.0.0.0` | the interface the `web` and `sync` roles bind, and the metrics endpoint with them — one decision. Empty or whitespace falls back to the default. `HOST=127.0.0.1` inside a container is **unreachable through `docker run -p`** — the proxy connects to the container's bridge address, never its loopback — and reachable only where the container shares the host's network namespace (`--network host`) or through a sidecar and `ssh -L` inside it. That is the exposure an app which admits one implicit actor without a login wants, and until 2026-09-07 such an app could not run in a container at all. `runRole({ …, hostname: '127.0.0.1' })` overrides the variable, the way `port` overrides `PORT`, for an app that must never trust the deployment to set it |
| `TLS_CERT` / `TLS_KEY` | unset | paths of a PEM certificate and its PEM private key, read once at boot by the `web` role, whose listener then serves TLS (a direct TLS socket counts as https: HSTS goes out with no proxy header). Both or neither, `X_CONFIG_INVALID` otherwise: one alone or a path that reads nothing is refused before any service starts, a file that is not PEM of the right kind when the listener is built. Unset — the default — the ingress terminates TLS. `sync` and the metrics endpoint stay plaintext |

| Failure | Code | Fix as printed |
|---|---|---|
| `ROLE` names something else | `X_ROLE_UNKNOWN` | `docker run -e ROLE=web <image>` |
| `PORT` is not a TCP port | `X_PORT_INVALID` | `docker run -e PORT=3000 <image>` |

**`ROLE=migrate` is the release phase.** It starts only the db/queue pair, applies the app's
migrations through the ledger — carrying `APP_VERSION` when set — logs `{ applied, available,
appVersion }`, and **exits**. It never holds a port and never serves. Every other role loads the
app's modules (importing them *is* registration), resolves the build id from `BUILD_ID` or the
manifest, assembles its routes, and holds until SIGTERM → [Deployment](Deployment).

The scaffolded `docker/Dockerfile` defaults `NODE_ENV=production ROLE=web PORT=3000`, exposes 3000,
and health-checks `/readyz`.

## x secrets

```bash
x secrets [show|init|edit|set <NAME>|rotate [--drop <keyId>]] [--json]
```

Two files, one committed and one never:

| File | Committed | Holds |
|---|---|---|
| `secrets.enc.json` | yes | the sealed envelope: `v`, `alg`, the master key's id, the IV, the ciphertext |
| `.secrets.key` | **no** — `x secrets init` writes the `.gitignore` rule before it writes the key | 64 hex characters, mode `0600`; on Windows, an ACL granting the current account alone |

`ULTIMATE_SECRETS_KEY` is read first and the key file second, so a container is handed its key by the platform and ships no key file at all.

**On Windows the mode keeps no one out** — every file reports `0666` and inherits the profile directory's ACL. So every key write (`init`, `rotate`, the staged `.secrets.key.next`) runs `icacls <temp> /inheritance:r /grant:r "<DOMAIN>\<user>:F"` on the temp file **before** the rename makes it live: one explicit entry, nothing inherited. Read it back with `icacls .secrets.key`. An `icacls` that fails writes no key at all: `X_SECRETS_KEY_ACL_FAILED`, fix `where.exe icacls`, or keep no key file and set `ULTIMATE_SECRETS_KEY`. A rename over a key another process holds open (an editor, an indexer, a virus scan) is retried 5 times over ~150 ms on `EPERM`/`EBUSY` before it fails. `As of 2026-10-05`.

**A secret is an environment variable.** The decrypted payload is a flat map of `ENV_NAME` to value, and `installSecrets()` writes each one into the process environment where nothing has already set it — the real environment always wins, so one image runs in Compose and on K8s with the same committed file. Everything downstream is what already existed:

```ts
// app.config.ts
import { defineEnv, type EnvSchema, installSecrets } from '@ultimat3/core';

await installSecrets();
export const envSchema = {
  SESSION_SECRET: { type: 'string', secret: true, description: 'Cookie signing key' },
} satisfies EnvSchema;
export const env = defineEnv(envSchema);
```

One declaration, one row in `.env.example`, one mask (`maskedEnvValues`), one redaction entry, one reader (`env.SESSION_SECRET`). There is no `secrets.get()` — a second accessor would be values with no declaration, no type and no mask.

| Subcommand | Does |
|---|---|
| `show` (default) | names, lengths, and whether `envSchema` declares each one; retired master keys by id (`retiredKeyIds`). **Never a value**, in either renderer |
| `init` | a fresh master key, the `.gitignore` rule, and an empty sealed file. Refuses to overwrite either file |
| `edit` | decrypt into a temp buffer outside the repo, open `$VISUAL`/`$EDITOR`, reseal on save. The buffer is deleted in a `finally` and by a `SIGINT`/`SIGTERM` handler; an unchanged buffer writes nothing |
| `set <NAME>` | one value, read from **stdin** — never argv, which lands in shell history and in `ps` |
| `rotate` | reseal the same values under a new master key. The committed file is written first and the key last: only the committed one can be restored from git. The key it replaces joins the ring — see below |
| `rotate --drop <keyId>` | remove one retired key from the ring, by id. Generates no new key and leaves `.secrets.key` alone |

**The key ring.** `seal()` writes under the current key; `open()` picks the key a value names. So a
rotation must keep the old key readable until every sealed value is re-sealed:

| Step | Command | State |
|---|---|---|
| 1 | `x secrets rotate` | new key live; the old one is in `secrets.enc.json` as `ULTIMATE_SECRETS_RETIRED_KEYS`, sealed under the new key. A deploy is still handed one key |
| 2 | the app's re-seal `backfill()` | every value whose `sealedKeyId()` is a retired id is opened and sealed again |
| 3 | `x secrets rotate --drop <keyId>` | the retired key is gone; a value still naming it is `X_SEAL_KEY_UNKNOWN` |

`ULTIMATE_SECRETS_RETIRED_KEYS` is comma-separated, 64 hex characters each, and reaches the
process through `installSecrets()` like any secret — the real environment wins. It is kept by
default and never behind a flag: `rotate` overwrites the only copy of the old key on disk, so
dropping it then would leave every sealed value unreadable. `show` reports it by key id, not as
an app secret.

```bash
$ x secrets init --json
{"ok":true,"command":"secrets","summary":"sealed secrets.enc.json — master key 4f2a…",
 "data":{"path":"secrets.enc.json","keyPath":".secrets.key","keyId":"4f2a…","gitignore":"added"}}

$ printf %s "$STRIPE_KEY" | x secrets set STRIPE_KEY --json
$ x secrets show
name            value       length     envSchema
SESSION_SECRET  [redacted]  44 chars   yes
STRIPE_KEY      [redacted]  32 chars   no
```

`--json` carries exactly what the terminal does, which is why no subcommand has a `--reveal` flag: the one way to see a value is `x secrets edit`, and the one way to read one is the app reading `env.<NAME>`.

Errors: `X_SECRETS_KEY_MISSING`, `X_SECRETS_KEY_INVALID`, `X_SECRETS_KEY_MISMATCH`, `X_SECRETS_FILE_MISSING`, `X_SECRETS_FILE_INVALID`, `X_SECRETS_TAMPERED`, `X_SECRETS_PLAINTEXT_INVALID`, `X_SECRETS_EDITOR_MISSING`, `X_SECRETS_EDIT_FAILED`, `X_GENERATE_CONFLICT` (`init` over an existing file), `X_CLI_BAD_FLAG` (`--drop` naming an id the ring does not hold).

## x auth

```bash
x auth seal-mfa [--json]
```

One subcommand, and no default: a bare `x auth` is refused (`X_CLI_BAD_FLAG` names the subcommand), as `x db`, `x mcp` and `x pr` are — the one subcommand rewrites credential rows, and the read-only answer (how many are unsealed) is `x doctor`'s. `seal-mfa` seals every `x_users.mfa_secret` still stored
in the clear, in place, under the app's master key (`As of 2026-10`). It is the one-shot an upgrade
onto sealed second-factor secrets owes — `completeMfa` refuses a plaintext value with
`X_MFA_SECRET_UNSEALED`, whose fix is this command, and `x doctor` reports how many rows are left. Beside a live `x dev` holding the embedded database it is refused `X_DEV_ALREADY_RUNNING`, fix `x stop --json && x auth seal-mfa && x dev` (`As of 2026-11-19`).

| | |
|---|---|
| Opens | the app's database, as every other command does (`DATABASE_URL`, or the embedded one) — the framework's tables are applied first |
| Needs | the master key: `ULTIMATE_SECRETS_KEY` or `.secrets.key`. With neither it is `X_SEAL_KEY_MISSING` and no row is written |
| Idempotent | a sealed value is counted and never rewritten, so an interrupted run is finished by running it again |
| Safe under traffic | each write is a compare-and-set on the value read: a user who re-enrolled mid-run keeps the new secret, and the row is counted `skipped` |
| Reaches | `PostgresAuthAdapter`'s `x_users`. An app on its own `AuthAdapter` calls `sealMfaSecrets({ adapter })` from `@ultimat3/auth` |

```bash
$ x auth seal-mfa --json
{"ok":true,"command":"auth","summary":"sealed 2 second-factor secret(s); 0 already sealed, 0 changed mid-run and left alone",
  "data":{"sealed":2,"alreadySealed":0,"skipped":0}}
```

Errors: `X_SEAL_KEY_MISSING`, `X_NOT_IN_APP`, `X_DB_UNAVAILABLE`, `X_AUTH_WRITE_FAILED`.

## x vapid

```bash
x vapid [show|create] [--json]
```

The Web Push key pair `pwa.push` signs with (RFC 8292), `As of 26.1.0`. Both halves are environment
variables — `ULTIMATE_VAPID_PUBLIC_KEY` and `ULTIMATE_VAPID_PRIVATE_KEY` — and never config, so they
cannot come from different pairs. [PWA and offline](PWA-And-Offline#push).

| Subcommand | Does |
|---|---|
| `show` (default) | names the pair the boot would sign with — `environment`, `sealed` (`secrets.enc.json`) or `development` (the published pair a local process falls back to, which a deployed boot refuses) — and its public key. **Never the private key**, in either renderer |
| `create` | mints a P-256 pair on WebCrypto and seals BOTH halves into `secrets.enc.json` in one write. Refuses (`X_GENERATE_CONFLICT`) when either is already sealed: a new pair unsubscribes every browser that subscribed with the old one, so rotating is `x secrets edit` (delete both lines) and then `create` — a decision, never a re-run |

```bash
$ x vapid create --json
{"ok":true,"command":"vapid","summary":"sealed a new Web Push key pair into secrets.enc.json — ULTIMATE_VAPID_PUBLIC_KEY and ULTIMATE_VAPID_PRIVATE_KEY",
 "data":{"path":"secrets.enc.json","publicKey":"BBwN…","sealed":["ULTIMATE_VAPID_PUBLIC_KEY","ULTIMATE_VAPID_PRIVATE_KEY"]}}
```

A key pair minted elsewhere (`web-push generate-vapid-keys`) is the same format: set the two variables
directly. `x env example` lists both in the Framework section once `pwa.push` is wired (`pwa.vapid`
set), and `x env check` reports a deployed table that lacks them (`X_PWA_VAPID_KEY_MISSING`).

`show` reads `development` only when there is nothing sealed to read — no `secrets.enc.json`, or no
master key for it. A sealed file it cannot open is that refusal, with its own fix
(`X_SECRETS_TAMPERED`, `X_SECRETS_KEY_MISMATCH`, `X_SECRETS_FILE_INVALID`): the pair is there, and
`create` would refuse it.

Errors: `X_SECRETS_KEY_MISSING` (`create` with no `x secrets init`), `X_GENERATE_CONFLICT`, `X_NOT_IN_APP`,
and the `X_SECRETS_*` refusals above.

## x status

`As of 2026-11-15`. `x status [--url <origin>[,<origin>…]] [--samples n] [--json]` — what the running deployment is, from what it already records. A read, exit 0 whatever it finds: whether one build is fully out is [`x deploy verify`](#x-deploy-verify)'s question.

| Half | Read from | `--json` |
|---|---|---|
| workers | every live row of `x_job_workers`, through the queue `x jobs list` opens (`DATABASE_URL`, else the embedded database) | `data.workers`: `count`, `draining`, `byBuild` (a row from before the build column is `unknown`), `rows[]` |
| origins | `--url`: `--samples` (default 5, 1–50) `GET /readyz` per origin, each on its own connection, so a load balancer chooses again | `data.origins[]`: `origin`, `samples`, `byBuild` (`x-ultimate-build`), `byStatus` (`unreachable` when nothing answered), `unstamped` (a 2xx with no build), `roles` (named by a role's health port) |
| unrecorded | — | `data.unrecorded`: `web`, `sync`, `scheduler`, `replicator` — no fleet-wide record holds their build; name each one's health origin in `--url` ([Known gaps](Known-Gaps#open-by-decision)) |

`--url` takes bare http(s) origins only — a path, query or credentials is `X_CLI_BAD_FLAG`, as is a `--samples` outside 1–50. Both are refused before any request or connection.

## x heavy

`As of 2026-11-18`. `x heavy [status] [--json]` · `x heavy run [--label s] [--mb n] [--max-wait s] [--json] -- <command…>` — the machine ledger every heavy run on this machine reserves its measured memory in, from any directory, in any repository. The rules, the weights and what stays outside: [Working with many agents](Many-Agents).

| Form | Answers |
|---|---|
| `x heavy` / `x heavy status` | `data.holds` and `data.queue` (label, directory, MB, pid, age; a hold adds `wrapperAlive` and `childPids`, the processes keeping it after its wrapper is gone), `data.capacityMb`, `data.usedMb`, `data.coreCap`, `data.cpuGate` (whether CPU pressure holds new runs back here), `data.machine` (load, runnable tasks, available and usable memory, `cpu`: `source` `psi`/`runnable`, `value`, `limit`, `busy`); `data.enabled: false` with `data.off` naming why (`ci`, `test-run`, `disabled`, `unsupported`) |
| `x heavy run -- <command…>` | runs it inside one reservation of `--mb` (default: a monorepo typecheck). Exit code passed through, `128 + n` for a signal, 127 and `X_HEAVY_COMMAND_NOT_FOUND` for no such program. SIGTERM and SIGHUP are forwarded. Its summary goes to stderr, so stdout stays the command's; with `--json` the one document is on stdout and the command's stdout moves to stderr. `--max-wait <seconds>` (`0` to `604800`) bounds the queue: past it the command never starts, `X_HEAVY_WAIT_EXPIRED`, exit 75, `data.started: false` |

## x config

`As of 2026-11`. `x config show [--section <key>]` — `app.config.ts` as the boot reads it: through `loadAppConfig` and core's `defineConfig`, every default merged. A credential-named key (the logger's own rule, `isRedactedKey`), a `secret()` value and the password in a URL's userinfo print as `[redacted]`. `--section` takes a top-level key the resolved record owns; any other is `X_CLI_BAD_FLAG` listing them.
