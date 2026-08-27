# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Ultimate

A full-stack, **Bun-only**, opinionated web framework. Rails' philosophy on a Bun + Postgres + SolidJS stack, where **the primary developer is an AI agent** and the secondary developer is a tired senior engineer working through their own AI agent and AI reviewer.

Rails' actual promise, applied to agents: **reduce the number of problems the author has to worry about**, so the work goes into the app's features instead of the app's infrastructure. Every decision the framework makes is a decision an agent does not have to.

This repo is the framework itself: a monorepo of `@ultimat3/*` packages, the `x` CLI, the docs, the wiki, and two tracked apps — one reference app (`examples/dummy`) and one deployed demo (`dummy/social-media-clone`), each gated on its own `expectedRed` table.

CLI binary: `x`. npm scope: `@ultimat3`. Import paths: `@ultimat3/<pkg>`.

**Status:** released, `As of 2026-08-24`. 30 `@ultimat3/*` packages plus the unscoped
`create-ultimate` — 31 in all — **versioned** in lockstep and **published** in lockstep: one version,
one commit, one tag, 31 tarballs.

**There is no package awaiting its first publish**, `As of 2026-08-26` —
`bun run scripts/registry-audit.ts --json` answers `31/31 publishable packages are on npm at
<version>, every one attested`. This block said `@ultimat3/notify` "has never been published" and
owed step 1 of [`PUBLISHING.md`](PUBLISHING.md) **before** the next release run; that was true when
written and the 16.0.0 run published it, so the sentence outlived its fact and would have sent the
next agent to perform a hand publish npm answers with `E403 … cannot publish over the previously
published versions`. Step 1 comes due again for the **next package added after a release run**, and
for nothing else: it is a package's only manual publish, ever, and `@ultimat3/notify`,
`@ultimat3/scraping` and `@ultimat3/flags` were the last three to need it. Ask the audit rather than
this paragraph — that is the rule this whole table exists for.

**This page states no version number, deliberately.** It carried one for two majors after the tree
moved past it, and a version written here is read as the installable one. Every row below is a
command instead: **run the right-hand column — never quote the left.** [`README.md`](README.md) and
[`llms.txt`](llms.txt) have been clean by construction since 2026-08-20 for this reason; this file
was the one that opted out. `bun run scripts/registry-audit.ts --json` covers every **npm** row in
one call — `N/N publishable packages are on npm at <version>, every one attested`, or each gap with
a runnable `fix:` — and it asks nothing about the tag or the Release, which are rows of their own.

| Fact | Read it yourself |
|---|---|
| what this tree is stamped at, per workspace | `bun run scripts/list-workspaces.ts --json` — `.data[].version`; one value across every workspace, or the tree is out of lockstep |
| the whole repository is stamped at one version | `bun run scripts/release.ts --check <version>` — exits 1 and names every finding when it is not |
| the release workflow names every publishable workspace | `bun run scripts/release-workflow.ts --json` |
| every one of them is on npm at that version, attested | `bun run scripts/registry-audit.ts --json` |
| what npm serves, and what `bunx create-ultimate myapp` installs | `npm view @ultimat3/core version` |
| provenance on a release | `npm view @ultimat3/core@<version> dist.attestations _npmUser` — `GitHub Actions` is the workflow; a person's name is a hand publish and carries no attestation |
| the tag is **annotated** and on the remote | `git ls-remote --tags origin 'refs/tags/v<version>*'` — both the ref **and** its peeled `^{}` line, which is what proves it. **Not** `git tag --list`, which reads the local repository and answered `v4.0.0` throughout the window in which the tag had never been pushed |
| the GitHub Release exists — the Release is what triggers the workflow | `gh release view v<version> --json tagName,isDraft,publishedAt` |
| the OIDC trusted publisher is attached, `Environment: npm-publish` | `NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json` — without a fresh OTP every package reads as missing |
| which majors have shipped, and what each one breaks | `grep -n '^## ' CHANGELOG.md` · [`wiki/Upgrading.md`](wiki/Upgrading.md), one section per major, newest first |

**A lightweight tag is not a release trigger, and `--follow-tags` will not push one.** `v4.0.0` was
first created with a bare `git tag v4.0.0`; `git push --follow-tags` pushed the commit, said nothing,
and left the tag local — `--follow-tags` pushes **annotated** tags only. The GitHub Release could
then not be created against a ref the remote did not have. `git tag -a` is the only form
[`PUBLISHING.md`](PUBLISHING.md) writes, for this reason.

**There are no publication holes, and `scripts/registry-audit.ts` is what keeps it that way.**
`@ultimat3/scraping` was the last one, bootstrapped by hand at 2.0.0 on 2026-08-19 —
`npm publish --access public --provenance=false`, the one-time step every package needs before a
trusted publisher can attach — and npm now answers `E403 … cannot publish over the previously
published versions: 2.0.0` on a retry. `@ultimat3/flags` was the same shape and was closed the same
way. Publication is a step apart from versioning, so the two can disagree silently: the audit runs
in CI and files a `registry-drift` issue when they do, which is exactly what it did during 4.0.0's
release window while the publish sat behind the `npm-publish` environment gate (issue #221, closed
when the run finished). The publish list itself is **derived** from `scripts/list-workspaces.ts`,
which is what keeps a new package from being silently absent from it. Step 1 of `PUBLISHING.md`
comes due again for the next package added after a release run, and nothing else.

**Every major here has been one sweep, in two halves.** Things **declared and never wired** are
wired or deleted (`JobsConfig.driver`, `realtime.heartbeatMs`, `PrecacheAsset.critical`,
`CaptureOptions.timeoutMs`, `PERIODIC_SYNC_TAG`, `requiresApp`); things that **answered the wrong
thing** are corrected (`on delete` reaching the generated SQL, `in` with a non-array operand,
`t.date` accepting an offsetless date-time, `isValidCron` accepting an unsatisfiable day/month
pair, a local disk's signed URLs carrying the driver kind rather than the registered disk name).
No codemod ships: each entry names its own manual edit.
[`wiki/Upgrading.md`](wiki/Upgrading.md) walks every major, oldest first, and states its own count —
`bun run changelog-check` reads each count from that major's own `CHANGELOG.md` section.

**The declared-and-never-wired half is now mechanised.** `bun run scripts/config-readers.ts` is a
ratchet over every leaf key of `AppConfig`, written because twelve such keys across four releases
had each been found by hand, in a major — `jobs.driver` accepted `'postgres' | 'redis' | 'nats'`,
had no reader anywhere, and boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` did
not throw, did not warn, and silently gave you Postgres. That is the dangerous direction, and it is
the one this repo keeps re-shipping; the guard's own header
([`scripts/config-readers.ts`](scripts/config-readers.ts)) calls it "the framework's most repeated
defect".

**Every package has an OIDC trusted publisher.** `developerz-ai` / `ultimate` / `release.yml` /
environment `npm-publish`, publish permission, all 30, verified per package with
`npx -y npm@12 trust list <pkg> --json` — `npm trust` shipped in **npm 12** and Bun's bundled npm
answers it as an unknown command, which is why `scripts/trust-publishers.ts` pins the runner. That
attachment is what lets [`.github/workflows/release.yml`](.github/workflows/release.yml) publish at
all: one tarball per publishable workspace per release, each attested,
`_npmUser: GitHub Actions`, on every release from 3.0.0 on.

**The `npm-publish` environment needs a human to approve the run.** The release workflow reaches
`waiting` and publishes nothing until a named reviewer approves the pending deployment — the last
point at which an irreversible publish can be stopped. `gh run view <id>` reports `waiting`, not a
failure.

**2.0.0 is the one release with no provenance**: no publisher was attached, so the OIDC exchange had
nothing to verify against, the workflow could not publish, and 2.0.0 went out by hand —
`_npmUser: sebyx07`, no `dist.attestations`, where 1.1.0, 1.2.0 and every release from 3.0.0 carry both. Not
"for the first time" — this file said that until 2026-08-19 and `CHANGELOG.md`'s 3.0.0 header still
does: 1.1.0 and 1.2.0 published under **earlier** publisher configurations, one per package, and
`npm view @ultimat3/core@1.2.0 _npmUser.trustedPublisher` answers an `oidcConfigId` that differs from
3.0.0's. 1.0.0 was the manual bootstrap.

Semver applies — a breaking change to a documented API needs a major, and the eight primitive shapes,
the `x` CLI surface and the tier table are as stable as the `X_*` codes already were.

Realtime capacity is **measured on one node, in two halves that answer different questions**.

**Reachability, 50,000 clients:** real WebSocket clients against a single `sync` node over
`InProcessTransport`, `SIGKILL`ed with no drain. All 50,000 reconnected; **49,981** received a
channel patch inside the window, p50 54.0s / p90 105.5s / max 145.7s; 156,851 connect attempts shed
by the `AcceptBudget` before any query or snapshot path. That figure times **first delivery on the
reconnected socket** — reconnect *and* resubscribe *and* one patch. It was labelled
"time-to-consistent" until 2026-08 and never measured consistency: the harness recorded
`lastSeenSeq` and read it nowhere, so a patch the node dropped was invisible to it by construction.
The timings are unchanged and still stand; only the name was wrong.

**Delivery, 10,000 clients:** the same harness, now counting holes in the probe sequence each client
receives, per connection ([`scripts/bench/restart-bench-seq.ts`](scripts/bench/restart-bench-seq.ts)).
10,000 clients, a probe every 200ms, all 10,000 reconnected: **1,666,882 patches received, 0 observed
sequence gaps** — no gap, no duplicate, no rewind on any client. A **lower bound**, not a proof of
zero loss: a hole is only visible between two frames one connection received, so anything lost before
a connection's first message or after its last is invisible, as is a connection that received nothing. It needs its own counter because a channel topic has
no cursor and no re-snapshot: a frame `SyncSocket.send` drops under backpressure is **unrepairable,
not uncounted**. `SocketRegistry.deliver`
([`packages/realtime/src/socket.ts`](packages/realtime/src/socket.ts)) reads `send`'s answer, adds
the drop to `channel_frames_dropped_total`, logs `channel.frames_dropped` with the topic, and
exposes `droppedChannelFrames` for a test that cannot scrape — this file claimed it ignored the
answer until 2026-08, and [`packages/realtime/CLAUDE.md`](packages/realtime/CLAUDE.md) always had it
right. Counted in three places and repaired in none is the accurate statement. `ChannelHub`'s bridge
(`channel.ts`) does discard `deliver`'s return, but that is a lost **count**, not a lost signal:
nothing above it would have re-sent the frame either way, which is why the sequence check is the
only thing that can say a run had no holes.
`As of 2026-08` this is the only run with delivery accounting — the 50,000-client result predates
the counter and carries no delivery number at all.

Per-node recovery in both: neither run crossed NATS and neither subscribes to a live query, so no
cursor, snapshot or gap-repair path is under test. Not a multi-node result and not a throughput
figure. [`scripts/bench/restart-bench.ts`](scripts/bench/restart-bench.ts), results committed under
[`scripts/bench/results/`](scripts/bench/results/).

Open: roadmap milestone 11's two-platform deploy proof — 1.1.0 gave a scaffolded app a real
deployable artifact (`packages/cli/src/serve.ts`; `x new` writes `apps/web/server.ts`,
`prerender.ts`, a Dockerfile and `docker-compose.prod.yml`; `ROLE=migrate` runs release-phase
migrations), and **4.0.0 gave it a chart** — `x new` writes `docker/helm`, 8 files: a
`Deployment` for each of the four roles enabled by default (`web`, `sync`, `worker`, `scheduler`),
`replicator` behind `enabled: false`, and `migrate` as a `Job` rather than a Deployment. So
`x deploy --method helm` runs `helm upgrade --install` against it with nothing to copy in. What is still missing is the **proof**, which is the milestone: the demo app on
Compose **and** K8s from one image, with an invisible rolling restart, has not been demonstrated.
Two things had to be true before it could be, and each was false in turn — until 2.0.0 `sync`'s
readiness probe polled a port the process never opened, and until 4.0.0 a scaffolded app had no
chart at all and `--method helm` exited `X_NOT_IMPLEMENTED`. Of the four known gaps
named in [`CHANGELOG.md`](CHANGELOG.md), **all four are closed in 2.0.0**, `As of 2026-08`:

| Gap | State |
|---|---|
| `x build --target binary` compiled and crashed at import | **fixed, and now proven** — the version read is lazy and `x build` passes `--define ULTIMATE_FRAMEWORK_VERSION`. `docker/Dockerfile` passes it too as of 2.0.0; it had not, so the target was fixed everywhere except in the artifact the framework ships. The image build now ends in `/out/app --version`, so a binary that cannot answer fails the build rather than the first command an operator runs |
| the shared cache tier's Lua invalidation `DEL`s keys it never declares in `KEYS` | **fixed** — the script returns the member list and the tier deletes value keys client-side, one key per `DEL`, so it is slot-local on Redis Cluster and Dragonfly |
| `docker-compose.prod.yml` pairs a published host port with `replicas` above 1 | **fixed** — a published host port has exactly one binder (reproduced: the second replica dies with `Bind for 0.0.0.0:3000 failed: port is already allocated`), so `web` and `sync` declare `replicas: 1` in all four files — framework, both tracked apps, and `x new`'s scaffold. Scaling either is the reverse proxy you add or the chart's per-role HPA, both named in the file header: Compose is the ladder's single-node rung and the box is the availability story |
| `resolveEnvironment` exists in both `core` and `seo` with different return types | **fixed** — seo's is deleted; core's is the one reader of `ULTIMATE_ENV`, and `'preview'` is now core's `'staging'`. The half that was not obvious: `ULTIMATE_ENV` is **not in the env schema**, so nothing validates it at boot and a `robots.txt` render can be its first reader — hence `tryResolveEnvironment()` in core, which answers `undefined` rather than throwing, instead of a second resolver in seo |

Milestone detail: [`docs/idea/14-roadmap.md`](docs/idea/14-roadmap.md).

## Design axioms (override any instinct that conflicts)

1. **One way to do each thing.** Ambiguity is the tax agents pay. Never add a second path.
2. **Define once, project everywhere.** One `action` → HTTP + OpenAPI + typed client + job handle + MCP tool + tests.
3. **Enforced, not documented.** A convention that isn't a build error doesn't exist.
4. **Errors are instructions.** Stable code + cause + exact fix command + `--json`.
5. **One command means shippable.** `x verify` is the contract.
6. **Static path never pays for the app path.** Separate bundle graphs, hard boundaries.
7. **Deploy anywhere = containers only.** Zero platform primitives in the framework.
8. **Ultimate ships mechanism; your app ships convention.** Mechanisms and *structural* conventions
   ship — the same for a bank and a blog. *Business* conventions never do. Primitives are functions
   returning values, so an app encodes its own by wrapping one: no fork, no patch, no plugin API.
   [`docs/idea/19-mechanism-not-convention.md`](docs/idea/19-mechanism-not-convention.md).

## Commands

| Task | Command |
|---|---|
| install | `bun install` |
| fresh clone to running | `bun run setup` — idempotent, so it is safe to re-run after every pull. It pins the Bun series CI runs, which is a different question from `engines.bun`: that one is a floor on who may install `@ultimat3/*`, this one is a floor on who may claim to have run the gate |
| **the gate** | `bun run verify` — `x verify` at the repo root, 20 steps: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. Green = shippable. The list is `VERIFY_STEP_NAMES` in `packages/cli/src/verify-step.ts`; `bun run scripts/gate-steps.ts` fails when a page states another number. |
| typecheck | `bun run typecheck` · start over: `bun run typecheck:clean` |
| lint | `bun run lint` · fix: `bun run lint:fix` · formatting alone: `bun run format` |
| test (all) | `bun run test` — every framework suite, opt-in ones included; `bun run test:watch` is the same set, re-run on change. The reference app is gated separately: `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify` |
| coverage, per package | `bun run coverage` (every package) · `bun run coverage:package <pkg>` — a package's own `src/` against its own tests, on a pin table. Scoped deliberately: `bun test packages/<pkg>` loads everything that package imports and Bun's summary averages over all of it, which read `@ultimat3/cache` at 35% while its own sources were at 98.8% |
| **the app gate** | `bun run scripts/reference-app-gate.ts` — both tracked apps' own 20 steps (`examples/dummy`, `dummy/social-media-clone`), blocking on a ratchet: a step passing today must keep passing, a step pinned in that app's `expectedRed` (`scripts/lib/gated-apps.ts`) must still be failing, and a `typecheck` that goes green must join the root `tsconfig.json` references |
| shrink the ratchet | `bun run scripts/reference-app-gate.ts --unpin <app>:<step>[,<step>]` — the edit `X_REFERENCE_APP_PIN_STALE` names, performed |
| test (one file) | `bun test packages/core/src/errors.test.ts` |
| test (one name) | `bun test packages/core/src/errors.test.ts -t 'notImplemented always carries a fix line'` — **always with a path**. `-t` filters test *names*, not files, so a bare `bun test -t <name>` still loads every test file in the repo into one process, where module-scope registrations from unrelated files collide and the run reports failures a scoped run does not |
| import boundaries | `bun run boundaries` |
| bare Errors in tests | `bun run scripts/test-bare-error.ts` — a step of the gate's `errors` check, standalone. A test may not report its own verdict by throwing a bare `Error`; `expect.unreachable` is the idiom. A ratchet, because 422 sites were already there — `--unpin <pkg>` lowers a count and refuses to raise one. A `new Error` **not thrown** is the subject's input and is never reported |
| unsafe error rendering | `bun run error-render` — a step of the gate's `errors` check, standalone. Refuses an `unknown` reaching a `cause:`/`fix:` through `${x}`, `JSON.stringify(x)` or `String(x)`; all three throw on real app values, and the bug shipped three times before it was mechanised |
| route vocabulary copies | `bun run render-modes` — a step of the gate's `unit` check, standalone. Refuses a second declaration of `RENDER_MODES` / `OFFLINE_STRATEGIES` / `HYDRATE_STRATEGIES` anywhere in `packages/*/src`, matched on the **literal set** rather than the name: the copy that did the damage was called `PwaRenderMode`. Two shared members is a copy, one is a coincidence — the highest innocent overlap in the tree is 1 |
| open closed-key tables | `bun run frozen-records` — a step of the gate's `unit` check, standalone. Refuses `const X: Readonly<Record<K, V>> = Object.freeze({…})`, which infers `T` from the literal and so accepts an EXTRA key in silence. `Object.freeze<Record<K, V>>({…})` is the one form. The command prints both tallies — closed-key freezes checked, and the `Record<string, …>` ones deliberately left open — so neither is written down here |
| a second `AsyncLocalStorage` | `bun run async-context-guard` — a step of the gate's `unit` check, standalone. `packages/core/src/async-context.ts` is the one module that may construct one **or import the class**; every other scope opens through `asyncContext<T>(subject)`. A module-scope `new` throws `TypeError` at module evaluation in a browser bundle |
| undocumented gate codes | `bun run gate-codes` — a step of the gate's `unit` check, standalone. `wiki/Error-Codes.md`'s never-ships list is a hand-copy of a derived set; nothing read it, because `checkErrorCodeDocs` counts any `X_*` in backticks **anywhere on the page** as documentation. A ratchet: 26 violations on day one |
| dishonest `sideEffects` | `bun run side-effects` — a step of the gate's `unit` check, standalone. Refuses a package whose `sideEffects` excludes a module that provably runs at import time, and an entry matching no file — a stale entry protects nothing while reading as a rule still in force. **Never `false` where a `registerErrorCodes()` runs**: measured, `false` on `@ultimat3/core` drops `schema-error-codes.ts`, which registers `@ultimat3/schema`'s titles because schema (tier 0) cannot register its own. The array form costs ~376 B an island against the lie, and 22,214 → 5,948 B against declaring nothing. A ratchet — 24 of 30 packages silent on day one; `--explain --json` prints the array the tree measures |
| changelog and migration drift | `bun run changelog-check` — a step of the gate's `unit` check, standalone. Two `##` headings sharing a version, an empty released section, `BREAKING —` still under `[Unreleased]` at a tagged commit, and each major's `wiki/Upgrading.md` count against **that section's own** entries — a count derived from the whole file cannot see a misplaced entry, because it only makes the number smaller |
| a caught value rendered into a refusal | `bun run scripts/catch-render.ts` — a step of the gate's `unit` check, standalone. The **second** rule beside `error-render`, because that one reads a parameter annotated `unknown` and a `catch (error)` binding is annotated by nobody: it measured green through a seven-site fix. Refuses `instanceof` / `String()` / `JSON.stringify()` / `${…}` on a caught value reaching a `cause:`, `fix:` or `detail:`. `renderThrowable(value)` is the total form, one import. A ratchet |
| a secret compared with `===` | `bun run secret-compare` — a step of the gate's `unit` check, standalone. Refuses `===` / `!==` / `.includes()` where an operand's NAME says it holds a credential; `timingSafeEqual` from `@ultimat3/core` is the one form. [`packages/auth/CLAUDE.md`](packages/auth/CLAUDE.md) has always said "never `===` on a secret" and nothing read it: all twelve `timingSafeEqual` sites in `@ultimat3/auth` were rewritten to `===` and the package's suite stayed green — `session.test.ts` 24 of 24 over the comparison a session cookie's authenticity rests on. A unit test cannot assert constant time, which is why the rule has to be static. A ratchet — 53 sites across 14 packages on day one, each pinned with the sentence saying what the value really is, and **`auth` is not on it** |
| a prototype member answered instead of `undefined` | `bun run proto-index` — a step of the gate's `unit` check, standalone. Refuses a computed read of a `Record<…>` object literal where the key is data: `TABLE[name]` answers an `Object.prototype` member, so `useService('constructor')` returned the `Object` function out of the function whose whole job is throwing `X_SERVICE_MISSING`. Thirteen instances across four sweeps, six of them fixed and written up before this existed, and it kept coming back. `Object.hasOwn(TABLE, key)` or a `Map` is the repair; a string-literal key, a null-prototype table and a read already guarded by `Object.hasOwn` / `in` are recognised rather than pinned. A ratchet — 102 reads across 18 packages on day one, per `scripts/lib/proto-index-pins.ts`, which carries a sentence per package saying why its keys are closed |
| a second backoff curve, or a die a test cannot control | `bun run flight-copies` — a step of the gate's `unit` check, standalone. Refuses a module other than [`packages/core/src/backoff.ts`](packages/core/src/backoff.ts) that raises a factor to an attempt and clamps it in one expression, and any **call** to `Math.random()` in shipped source. Written because a sweep deleted THREE curves — `jobs/retry.ts`, `ai/gateway.ts`, `realtime/thundering-herd.ts`, with `db/transaction.ts` retrying on no backoff at all — and nothing stopped a fourth; three jitter strategies between them meant fixing a backoff bug was four files and missing three. Matched on **shape**, never on the name: the first draft looked for a roll called `random`/`rng`/`roll` and read straight past a copy whose parameter was `r`, exactly as a rule spelled `RenderMode` read past `PwaRenderMode`. A `random = Math.random` **default parameter** is the injectable seam and is never reported; a `Math.random()` **call** is, because it made `ai/gateway.ts` the one engine of four with no test at all. Pinned at **zero**, enforcing outright — the sweep landed first |
| a test that cannot fail on ordering | `bun run index-of-order` — a step of the gate's `unit` check, standalone. Refuses an ordering assertion built on `indexOf` **or `findIndex`** — both answer `-1` identically — with nothing asserting the needle is PRESENT, and the guard must be on the SAME expression: `GUARDS.some(body)` let an unrelated `expect(res.status).toBe(200)` silence it, which hid a mail client that skipped `STARTTLS` entirely while its ordering test stayed green. `indexOf` answers `-1`, and `-1` is less than every real index, so the assertion holds when the thing it orders is **not emitted at all** — measured, deleting a `drop constraint` emission left `packages/db/src/retype-keys.test.ts` green, and the sweep then found **24 more across 11 packages**, including `expect(names.indexOf('body')).toBeLessThan(names.indexOf('authz'))` under a test named "body validation runs before authz". Which operand is at risk is **not symmetric** and that is the whole rule: `X.toBeLessThan(Y)` is passed by a phantom `-1` in `X`, `X.toBeGreaterThan(Y)` by one in `Y`; the safe side fails loudly and is never reported, because noise is how a rule gets switched off. A ratchet, pinned at **zero** — the sweep landed first |
| a cleanup a skipped suite never runs | `bun run skip-if-cleanup` — a step of the gate's `unit` check, standalone. Bun evaluates a skipped file's module body, so a module-scope `entity()` REGISTERS, and then runs no hook inside `describe.skipIf(true)`. Measured with `TEST_DATABASE_URL` unset: **19 live suites leaked 36 entities**, and the leak WAS the house convention — the two files a review named were following it, so repairing only those would have left thirty-one of the thirty-six leaked entities in place. Refuses both leak routes: the reset parked in the skipped block, and a file-scope hook that returns early on the same condition — a rule spelled "is it inside a `describe`" reads straight past the second. `clearTimeout`/`clearInterval` are builtins, not registries, and are never reported. Pinned at **zero** |
| a second SQL string-literal escape | `bun run sql-literal-copies` — a step of the gate's `unit` check, standalone. Refuses a `replace`/`replaceAll` whose replacement is `''` anywhere but [`packages/db/src/sql.ts`](packages/db/src/sql.ts). Three copies shipped and **two were wrong the same way**: doubling the quote is only an escape while `standard_conforming_strings` is `on`, a GUC settable per session, per database and per role with no privilege — measured, `'dd' ~ '^\d+$'` is FALSE with it on and **TRUE** with it off, and an app's `.default('C:\logs')` stores `C:logs`. A CHECK enforcing a pattern nobody wrote and a column defaulting to a value nobody wrote, with no error at generation or at apply. `literal()` emits `E'…'` **only** when the value carries a backslash, so every migration already on disk is byte-identical. Matched on the **transformation**, never a name — the three copies were called `literal`, `literalText` and an unnamed inline splice, exactly the trap a rule spelled `RenderMode` fell into with `PwaRenderMode`. Pinned at **zero**, enforcing outright — the sweep landed first |
| a `node:` import with no reason | `bun run node-imports` — a step of the gate's `unit` check, standalone. Refuses a `node:` import carrying no `why:` comment on it or directly above — the second half of the **Bun only** non-negotiable below, which nothing read: 146 unexplained imports on day one — and that number was itself the defect, because the ratchet **skipped every test file** until 2026-08-26 while the scanner read them fine (#365). A test named "a test file is a test — its imports are the harness, not the shipped surface" asserted the hole as correct, which is how it held. Tests are in the corpus now, and so is the debt the skip hid: **545 unexplained across 16 packages — 141 in shipped source, 404 across 164 test files**, taken to **209** by the sweep that landed with the fix. `--json` re-derives the table; never read the number here. A specifier inside a string literal or a comment is a fixture and is never reported. `scripts/lib/node-import-pins.ts` records the table, and `--json` re-derives it. A literal `why:` token, not "a comment nearby", because the sentence naming the Bun native that was missing is what lets the next agent delete the import when Bun ships it, and only a token is greppable. A ratchet |
| a drawn arrow no manifest declares | `bun run package-map-graph` — a step of the gate's `unit` check, standalone. Every arrow in [`docs/architecture/01-package-map.md`](docs/architecture/01-package-map.md)'s mermaid fence must be a dependency the `from` package's own `package.json` holds, and every publishable workspace must be a node on it. Eleven arrows described imports no manifest and no module ever made, `ui` sat in the wrong tier subgraph and `scraping` was absent entirely; they were corrected by hand and nothing read the graph afterwards, which is axiom 3. Inside the fence only — the prose above it writes two of the wrong arrows as examples, and `<!-- … -->` ends in one |
| a framework table no boot creates | `bun run framework-tables` — a step of the gate's `unit` check, standalone. Every literal `create table` in `packages/*/src` must name a relation some `FRAMEWORK_SCHEMA` row creates. `packages/auth/src/tables.ts` declared `x_users`, `x_sessions`, `x_accounts`, `x_verifications` and `x_api_keys` and **nothing applied them, in dev or in production, from the initial commit through all 21 released versions**: they are not `entity()` declarations so `x db gen` never saw them, and the file exported the DDL for an app to paste into a migration nobody wrote — `examples/dummy/CLAUDE.md` recorded the symptom, that nobody could hold a session, without anyone reaching the cause. The third face of `jobs.driver`, after `config-readers` and `declaration-readers`, and the one that fails in production rather than at boot. An **interpolated** table name is the app's by construction (`@ultimat3/ai`'s `ddlSql(target)`, `@ultimat3/db`'s generator) and is never reported, nor is `packages/cli/src/templates/`, which the CLI writes and never runs. Pinned at **zero**, enforcing outright — the sweep landed first |
| a config key nothing reads | `bun run scripts/config-readers.ts` — a step of the gate's `unit` check, standalone. Every leaf key of `AppConfig` needs a reader in `packages/*/src`, or a pinned reason. Twelve keys across four releases were found by hand before this existed — `jobs.driver`, `realtime.heartbeatMs`, `database.poolSize`, `pwa.installPrompt`, `auth.afterSignInPath`, `ai.modelEnv` and the rest. A ratchet |
| a documented config key that does not exist | `bun run scripts/doc-config-keys.ts` — a step of the gate's `unit` check, standalone, and the other half of `doc-fixes`: that one resolves the `x <command>` in a `fix:`, this one resolves the `<section>.<key>`. Narrow on purpose — a dotted key on a line that also names `app.config.ts` or `defineConfig` — so its findings never have to be argued with |
| a URL on a host that 404s | `bun run dead-docs-host` — a step of the gate's `unit` check, standalone. Refuses a string literal building a URL on `ultimate.dev`, a host that answers **404 on every path** and that shipped as the `docs:` line of roughly ninety error declarations plus a `docsFor(code)` helper in four packages. `ERROR_DOCS_URL` in `@ultimat3/core` is the one answer, and `UltimateError` resolves it from the registered descriptor, so a declaration needs no `docs:` line at all. A comment naming the host as the thing that was removed cannot 404 and is never reported. Pinned at **zero** on day one — the sweep landed first, so this one enforces outright; the reason a sweep alone was not enough is that `scripts/new-package.ts` wrote the dead URL into every future package's `errors.ts` template |
| a factory counted instead of listed | `bun test scripts/primitive-factories.test.ts` — a step of the gate's `unit` check, standalone. An exported function returning an `Action` or a `JobHandle` needs a row in `PRIMITIVE_FACTORIES`, and a row needs a function. Lives in `scripts/` and not in `@ultimat3/core` because the table is tier 0 and the scan has to read `ai`, `jobs`, `scraping` and `action` |
| a browser barrel that reaches `node:async_hooks` | `bun test scripts/browser-barrel.test.ts` — a step of the gate's `unit` check, standalone. Bundles every package that touches the ALS seam **for the browser and evaluates it**, closing the two blind spots `async-context-guard` names in its own header: `await import('node:async_hooks')` and `const C = hooks.AsyncLocalStorage; new C()`. The barrel set is derived from source; the hand-written line is a FLOOR that may only shrink |
| regenerate manifest | `bun run manifest` |
| stale `@ultimat3/*` ranges in `bun.lock` | `bun run lockfile` reports, `bun run lockfile:fix` performs the edit `X_LOCKFILE_STALE` names. `bun install` will not do it: Bun refreshes a workspace block only when that workspace's own manifest changed, and `--frozen-lockfile` accepts every stale one, because a workspace edge resolves by NAME and the range is never read back. Surgical on purpose — `rm bun.lock && bun install` fixes the pins and drags every external dependency to its newest matching release with it |
| list workspaces | `bun run workspaces:list` |
| new framework package | `bun run scripts/new-package.ts <name> --tier <n>` |
| the CLI, in-repo | `bun run x -- <args>` (e.g. `bun run x -- doctor --json`) |

Run everything from the repo root. Prefer `bun run verify` before claiming work is done.

## Layout

```
packages/       the framework — one package per responsibility, tiered (see below)
examples/dummy/ the reference app: every primitive, once, idiomatically
dummy/social-media-clone/  the deployed demo app: production image built on every push to main
docs/idea/      what and why — the design spec
docs/architecture/  how it's built — internals
docs/ops/       running an app for real — PaaS → Compose → K8s, secrets, observability, runbooks
wiki/           the reference manual, and the only public documentation surface (synced to the
                GitHub wiki). There is no separate marketing site — decided 2026-08
scripts/        setup, verify, boundaries, manifest, release, bench
docker/         Dockerfile + compose + helm
llms.txt        the machine-readable repo map
framework.manifest.json  GENERATED by `bun run manifest`: packages, tiers, every X_* code with
                its owner and the file that declares it — scripts/ gate codes included. Never
                hand-edited — drift fails `bun run verify` (X_MANIFEST_DRIFT)
```

## Package tiers — imports may only go DOWN

A package may import from strictly lower tiers. Never sideways within a tier, never upward. Enforced by `bun run boundaries`; a violation is a build error. The table below is prose — [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts) is the executable copy, and they must agree.

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` |
| 2 | `entity`, `policy`, `http`, `auth` |
| 3 | `action`, `query`, `jobs`, `realtime` |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify` |
| 5 | `admin`, `testing`, `cli`, `scraping` |

Declared sideways edges, each earning its line: `core → schema`, `realtime → query`, `cli → admin`, `cli → scraping`, `cli → testing`, `create-ultimate → cli`.

**`cli → scraping` was declared 2026-08-21, and moving `scraping` down to tier 4 instead was refused.** `x shot` drives a real browser and `@ultimat3/scraping` is the one package that can. Its real imports are `core`, `jobs`, `schema` and `storage` — highest tier 3 — so tier 4 *is* its floor, and the `admin → ui` argument above would say to move it and delete the exception. That argument does not apply here, because tier 5 is not a misplacement: [`packages/scraping/CLAUDE.md`](packages/scraping/CLAUDE.md) puts it at 5 to reserve room for `recover: 'agent'` to import `@ultimat3/ai` (tier 4), and a package at 4 cannot import a package at 4. That file named this edge before anything imported the package: it wrote that because `cli` is also tier 5, a CLI command driving a browser would one day need a declared `cli → scraping` edge in the table. A tier that is holding a position is not a hole; deleting it would trade a documented future capability for one fewer line in a table.

**`admin → ui` is gone, and `ui` moved 5 → 4, decided 2026-08-19.** The edge was justified on
composition grounds — "the admin dashboard *is* the ui kit" — which is true and was never the
reason it was needed: `ui` imports `core`, `i18n`, `money` and `time`, so tier **2** is the lowest
its real imports allow and tier 5 was two tiers too high. The exception existed only to undo that
placement. `ui` sits at 4 rather than at its floor so `render → ui` stays forbidden (both at 4),
which [`packages/render/CLAUDE.md`](packages/render/CLAUDE.md) requires — the static bundle graph
may not reach the design system, which is axiom 6. An exception line in an enforcement table is a
rule with a hole in it, and deleting the hole beats arguing for it.

**The FLOOR is enforced too, `As of 2026-08-22`.** `boundaries.ts` derives each package's floor from
its shipped imports and refuses a package sitting above that floor with no row in `FLOOR_ABOVE`
([`scripts/lib/tiers.ts`](scripts/lib/tiers.ts)) — `X_TIER_FLOOR_UNDECLARED`, which also fires on a
row whose reason is blank, because "there was a reason" is the documentation axiom 3 says does not
exist. The reverse is a build error too: a row for a package that has since reached its floor, or
for a name the tier table does not carry, is `X_TIER_FLOOR_STALE`. Until then the ceiling was the
only half checked, while that file's own comment claimed the floor was checked "by this file's own
rule, not by opinion".

**Nothing moved when the rule landed.** Every package above its floor already had the sentence in
its own `CLAUDE.md`; `FLOOR_ABOVE` collects them, and each states what moving the package DOWN
would **legalise** rather than why the current tier feels right — `policy`, `pwa`, `render`,
`scraping`, `ui`. `bun run boundaries --json` re-derives the set. `pwa` at its floor of 2 is the
clearest case: `render → pwa` becomes an ordinary downward import, the service-worker generator
joins the static bundle graph, and axiom 6 loses the build error both packages' `CLAUDE.md` rely on.

**`cli → testing` was declared 2026-08**, when `bun run boundaries` learned to follow relative specifiers. `packages/cli/src/serve.live.test.ts` had been importing `../../testing/src/sealed-network` with a comment saying the package specifier "is a sideways import the boundary check refuses" — an evasion the check could not see. `@ultimat3/testing` was already a runtime `dependencies` entry of `@ultimat3/cli`, so the manifest had crossed the edge all along; declaring it makes the rule enforce what shipping already assumed. `create-ultimate` sits above the table at tier 6 and its declared edge is its *only* permitted import.

**`core → schema` was declared 2026-08-27, and the reverse stays forbidden.** Five declarations
were duplicated on the core side — `CURRENCY_CODE_PATTERN`, `describeValue`, `charCount`,
`SCHEMA_ERROR_CODES`, `isIanaZoneName` — held equal by **394 lines of pin test in `@ultimat3/cli`**,
a tier-5 package pinning a tier-0 invariant that no rule required to exist. `describeValue` is what
prints *instead of* a rejected password, so the safety property of the framework's most
security-sensitive renderer rested on a 63-line behavioural pin at tier 5. The lower-tier
extraction option (b) has no home: `schema` already imports nothing, and there is nowhere below
tier 0 for a sixth package. `schema → core` stays forbidden **on its merits** — `t` is in every
bundle graph an app has — so the three copies going THAT way (`singleLine`, `ERROR_DOCS_URL`, the
`Symbol.for('ultimate.error')` key) remain, now pinned at tier 0 by
`packages/core/src/single-line-pin.test.ts`.

**The cost was measured, not argued** — axiom 6 makes it a measurement.
`bun build --target=browser --minify`, one entry per row:

| one import | before | edge only | edge + honest `sideEffects` |
|---|---|---|---|
| `UltimateError` from `core` | 6,362 B | 19,018 B | **7,352 B** |
| `useUi` from `@ultimat3/ui` | 15,583 B | 28,284 B | **16,593 B** |
| `moneyText` from `@ultimat3/ui` | 27,203 B | 26,838 B | **19,417 B** |

The edge ALONE triples a core-only chunk: importing schema's barrel with no `sideEffects` field
forces a bundler to keep every module it reaches, and `@ultimat3/schema` declared none.
`bun run side-effects` had already **measured** the package as having no import-time effect and
nothing had written it down; with `sideEffects: false` the edge costs ~1 kB on a chunk that did not
already carry schema, and `moneyText` — which always did, through `@ultimat3/money` — comes out
**7.8 kB smaller** because the duplicates are gone.

**`db` is tier 1, decided 2026-08.** It imports `core` and nothing else, so tier 1 is the lowest its real imports allow — and that is what lets `entity` (tier 2) hold its own Postgres driver (`postgresDriver()`) instead of exiling it to a tier-3 package. Two things would have been wrong: a second package owning `Driver`'s only production implementation (two places to look for "where rows live"), and `database()` callers importing the seam from one package and the driver from another. Same shape as `auth → db`.

Adding a package means picking its tier first. If it doesn't fit a tier, the design is wrong — fix the design, don't widen the table.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything in the framework is one of these. **If a feature doesn't fit one of them, it doesn't ship.** Don't invent a ninth. Canonical shapes: [`docs/idea/02-primitives.md`](docs/idea/02-primitives.md). The list is executable, not prose: `PRIMITIVE_KINDS` in [`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the single source `PrimitiveKind` derives from, and `registrar.test.ts` pins it at these eight — a ninth entry is a failing test, per axiom 3.

**`llm()` is an action factory, not a ninth primitive — decided 2026-08.** A model call is a server-authoritative operation with an input schema, an output schema and a policy, which is the definition of an `action`; so `llm()` ([`packages/ai/src/llm.ts`](packages/ai/src/llm.ts)) *returns* one. That is what gives a model call `.tool()`, `.openapi()`, `.client()`, `.job()` and `.contract()` for free, one authz object across every surface, and a place in the manifest — none of which a ninth primitive would have inherited. The rule generalises: a new capability arrives as a **factory over an existing primitive**, never as a new kind of thing.

**`backfill()` is a job factory, decided 2026-08.** A one-pass sweep over a table is durable background work with an input schema, a retry policy, an idempotency key and a queue, which is the definition of a `job`; so `backfill()` ([`packages/jobs/src/backfill.ts`](packages/jobs/src/backfill.ts)) *returns* one, and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row. The pass is `inBatches()` — one statement per page — with every page in its own `step.run`, so a killed attempt resumes on the page it stopped at. What a step persists is a cursor, never the page. **`handle` is at least once**: it runs before its checkpoint lands, so an attempt cancelled between the two replays that page — the handler must be idempotent (`upsertAll`, `updateWhere`, a statement whose second run changes nothing), never `count + 1`.

**The factories are a list, never a count and never an ordinal.** `PRIMITIVE_FACTORIES` in
[`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the executable set: an
exported function outside its owning package that returns an `action` or a `job` has a row there or
`scripts/primitive-factories.test.ts` fails, and a row nothing exports fails the same test. Adding a
factory is adding a row, not editing a sentence. Three file headers each called themselves "the
fourth instance" and at most one could have been right — the list is sorted by package then name, so
**no ordinal is derivable from it**, and any prose ordinal is wrong the moment the next factory
lands. `As of 2026-08-22`.

## Non-negotiables

- **Bun only.** No Node-specific APIs unless via `node:` and unavoidable, and then with a comment saying why.
- **No new dependencies** without a strong reason stated in the PR. Bun's natives replace most of them. The strong-reason bar and where a dependency may live (driver/transport seam only, never the primitive vocabulary) is [`docs/idea/18-build-vs-wrap.md`](docs/idea/18-build-vs-wrap.md)'s build-vs-wrap criterion.
- **No `any`.** Biome fails the build. Use `unknown` + a schema parse.
- **Never throw a bare `Error`.** Subclass `UltimateError` with a code, a cause, and an executable `fix:`. Codes are `X_SCREAMING_SNAKE` and stable forever once shipped.
  **In tests too, `As of 2026-08`** — `checkErrorFixes` skips test files, so the rule was prose there and 422 sites accumulated under a green gate. `scripts/test-bare-error.ts` is the mechanical half, on a per-package ratchet. It reports a `throw new Error(…)`, which is the test stating its own **verdict**, and never a `new Error` that is merely handed to the code under test — a foreign error is legitimate **input**, which `packages/realtime/CLAUDE.md` has always said.
- **SRP.** One file, one job. Target < 200 LOC, hard ceiling ~500. Split before you exceed it.
- **Named exports only.** No default exports. `src/index.ts` re-exports the public API explicitly — no blind `export *`.
- **`import type` / `export type`** for type-only imports (`verbatimModuleSyntax` is on).
- **Tests next to source** as `<file>.test.ts`. A test that can't fail isn't a test.
- **`--json` on every CLI command and every error.**
- **No hardcoded user-facing strings.** Everything through `t()`.
- **No raw colours.** Semantic tokens only, in every component and stylesheet.
- **No date formatted without an explicit IANA `timeZone`.** No ambient default, anywhere.
- **No float money.** `Money = { readonly minor: number; readonly currency: string }`, always both — one
  declaration in `@ultimat3/schema`, aliased by `money` and `entity`, never restated and never a `bigint`.

## Conventions

- File names `kebab-case.ts`. Single quotes, semicolons, 2-space indent, 100 cols, trailing commas — Biome owns this, don't argue with it.
- A 1–4 line header comment per file stating its single responsibility.
- Comments explain **why**, never what.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands).
- Route files: `page.tsx` on `site/`/`app/`, `route.ts` on `api/` — the directory is the URL, never the filename. `index.tsx` is not a page and `<name>.tsx` is not a route; `registerRoute()` enforces it (`X_ROUTE_FILE_INVALID`).
- i18n catalogs: one flat file per locale, never a directory per locale or a file per feature. **Two
  paths, and they are different things** — an **app's** catalogs live at
  `packages/i18n/catalogs/<locale>.json` (`CATALOG_ROOT`, what `x g route` / `x g resource` merge
  keys into, and what both tracked apps have on disk); the **framework's own** catalog is
  `packages/i18n/src/catalogs/en.json`, imported by `framework.ts`. `x i18n check` audits the first;
  the `boundaries` step audits the second (`X_CATALOG_KEY_UNREACHABLE`), because the framework repo
  is not an app and the app check cannot read it.
  **Pointing `x i18n check` at this repo does not answer `ok`** — this file said so until 2026-08-20
  and `packages/cli/src/cmd-i18n.ts:289` calls `requireAppRoot('i18n', ctx.cwd)`, which refuses with
  `X_NOT_IN_APP` before a catalog is loaded. The vacuous green was one step further in: an app WITH
  an `app.config.ts` and no catalogs at all loaded zero locales and passed, and a catalog on disk
  that no module registered passed with it. Both are now refused — `X_CATALOG_UNREGISTERED` — and
  `i18n` is a step of the gate in its own right, so an app can no longer ship every user-facing
  string as `⟦key⟧` under a green `x verify`.
- Docs style: lead with the rule, fragments over sentences, tables for any ≥3-row structure, no meta-framing, no trailing summary. Date load-bearing claims `As of 2026-07`.

## Where things live

| Need | Go to |
|---|---|
| the design rationale | [`docs/idea/`](docs/idea/README.md) |
| how a subsystem actually works | [`docs/architecture/`](docs/architecture/README.md) |
| the coding contract in full | [`docs/architecture/00-conventions.md`](docs/architecture/00-conventions.md) |
| **adding a feature, step by step** | [`docs/architecture/15-adding-a-feature.md`](docs/architecture/15-adding-a-feature.md) |
| running an app in production | [`docs/ops/`](docs/ops/README.md) |
| which rung of the scale ladder a claim belongs to | [`docs/idea/17-scale-ladder.md`](docs/idea/17-scale-ladder.md) |
| every error code | [`wiki/Error-Codes.md`](wiki/Error-Codes.md) |
| every CLI flag | [`wiki/CLI-Reference.md`](wiki/CLI-Reference.md) |
| what idiomatic usage looks like | [`examples/dummy/`](examples/dummy/README.md) |

## CI

Free GitHub Actions runners (`ubuntu-latest`) — never a paid runner. Target under 5 minutes.

`ci.yml`'s jobs, each answering a question no other job answers — `awk '/^jobs:/{j=1;next} j && /^  [a-z-]+:$/{print $1}' .github/workflows/ci.yml` re-derives the list:

| Job | The question only it answers |
|---|---|
| `verify` | the gate, `x verify` verbatim — lint, typecheck, boundaries and every suite are its **steps**, never a second job |
| `reference-app-verify` | both tracked apps' own gate, on its ratchet |
| `scaffold-smoke` | `x new` → `bun install` → the documented first run (`x db gen`, `x db migrate`, **every** generator in `GENERATORS`) → the scaffolded app's own `x verify`, outside the checkout |
| `container` | `docker/` as a built artifact — every stage of the image, ending in the runtime stage's own `/app/x --version`, plus `helm template` assertions the chart's own values can fail |
| `package-list` | the matrix for the job below, **derived** from `scripts/list-package-dirs.ts` rather than hand-listed |
| `package` | each package tested and covered **alone** — a suite that only passes because another package's preload registered something first is green in `verify` and red here. Its one step is `bun run scripts/coverage-gate.ts --package <pkg>`; there is deliberately **no `lint` step**, because `bunx biome check packages/<pkg>` is a strict subset of the `verify` job's `biome check .` and cannot fail on its own |

**`container` is the one job with no `./.github/actions/setup`, deliberately.** Nothing in it runs bun, so the composite's frozen install would be pure latency; `docker`, `helm` and `jq` come from the runner image and its first step refuses by name if one stops shipping. Every other job starts with the composite — bun, the install cache, a frozen install.

The workflows, `As of 2026-08-22` — `ls .github/workflows`:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, every PR | the jobs above |
| `release.yml` | a **published** GitHub Release | every publishable workspace to npm via OIDC trusted publishing, behind the `npm-publish` environment gate. The list is **derived** by `scripts/release-workflow.ts`, never a number written here |
| `registry-audit.yml` | daily cron | `scripts/registry-audit.ts`; files a `registry-drift` issue when the tree's stamped version and the registry disagree. Not a `ci.yml` job because it asks about the **registry**, which no commit changes |
| `deploy-social-demo.yml` | push to `main` | builds and publishes the demo app's production image |
| `wiki.yml` | push to `main` | mirrors `wiki/` into the GitHub wiki |

Releases publish with **provenance** — which 2.0.0 did not get, because no trusted publisher existed for the exchange to verify against. All 30 were attached on 2026-08-19, and every release from 3.0.0 on has gone out through the workflow: `npm view @ultimat3/core@<version> dist.attestations _npmUser`. See [`PUBLISHING.md`](PUBLISHING.md).

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.

**Only the top-level agent spawns subagents.** A subagent does the work it was given and reports
back — it never delegates further. Nested fan-out is why a 4-agent sweep becomes 17 running agents:
the count stops being knowable, the disjoint-files split stops holding, and two grandchildren edit
the same file. A subagent that finds its scope too large says so in its report and returns; widening
the split is the top-level agent's call.
