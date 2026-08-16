# 10 — Test quality and the harness

> Part of [`overview.md`](overview.md). Depends on: none. Land alongside
> [`05-gate-and-scripts.md`](05-gate-and-scripts.md) — both are about the gate meaning what it says.

Findings are **mutation-tested**: break the source, see whether a test notices, revert. Everything
below was reproduced on this checkout.

**Coverage breadth is genuinely strong** — 17 of 19 semantic mutations across policy, tenancy, retry,
transactions, reconnect, audit, fleet-leases, vector scope, rate-limit, storage paths and XML escaping
were caught. The defects are in the **harness** and in three specific files, not in breadth. Say so
when reporting: this slice is not "the tests are bad".

## Critical

### 1. `bun run test` is RED at HEAD while `x verify` is GREEN

`packages/ui/src/theme/inert-render.test.ts:113-239` — 26 tests whose outcome is decided by **module
load order**. The file's premise is that ui's `.tsx` components compile to its own local inert `h`
installed as `globalThis.React.createElement` (`:91,:100`). But `packages/render/src/index.ts:3` calls
`installRenderLoader()` **at import**, registering a process-global `Bun.plugin` `onLoad` for
`/\.tsx$/`. Any test file anywhere in the process that imports `@ultimat3/render` makes every ui
component loaded after it compile to render's `h`; the nodes are no longer `{inert:true}`, `render()`
falls to `String(value)`, and 26 assertions get `"[object Object]"`.

Reproduced deterministically, **both argument orders**:

```
bun test packages/ui/src/theme/inert-render.test.ts                        → 28 pass,  0 fail
bun test packages/render/src/module-loader.test.ts <then> inert-render     → 18 pass, 26 fail
bun test packages/ui/src/theme/inert-render.test.ts <then> module-loader   → 18 pass, 26 fail
```

Full-suite state, four separate runs:

```
bun run test           → 7996 pass, 128 skip, 26 fail, exit 1   (identical every run)
bun run x -- test unit → 8/8 shards ok, "705 test file(s) on 8 worker(s) passed"
```

`runParallel` packs shards by byte size (`bySizeThenPath`), so which files share a process — and
therefore whether the render plugin is installed before ui's components load — is an accident of file
sizes. **Adding, deleting or resizing any test file in the repo can flip it in either direction.**

What could ship undetected: any regression in `@ultimat3/ui`'s server-render path — the surface 23 of
29 tracked routes render on — because the file is either measuring the wrong factory (sharded green)
or failing for a reason nobody attributes to a real defect (single-process red).

Fix, both halves:
- **Make the premise explicit rather than ambient.** One line at the top of the describe —
  `expect(isNode(Field(props))).toBe(true)` — turns the silent `[object Object]` into "this file's
  factory was bypassed". Better: load the components through a scoped transform the file owns.
- **Make the gate reproducible.** `x verify`'s unit step must agree with `bun run test`: shard
  deterministically by package so a package's files always share a process, or add a step that runs
  the unit suite in one process. A gate whose result depends on byte-size packing is not a gate.

### 2. The Redis tier's two Lua scripts are never executed

`packages/cache/src/redis.test.ts:67-92` and `packages/cache/src/invalidate.test.ts:48-63` — both
fakes match on `args[0] === REDIS_TAG_MEMBER_SCRIPT` / `=== REDIS_INVALIDATE_SCRIPT` (identity of the
exported constant) and then apply their own TypeScript copy of what the script is supposed to do. The
script body is inert text; **the tests assert the fake against itself.**

Mutations that survive all 517 tests in `packages/cache` + `packages/query`:

```
TAG_MEMBER_SCRIPT   →  "return 1"    517 pass, 0 fail
INVALIDATE_SCRIPT   →  "return {}"   517 pass, 0 fail
```

The second is the shared cache tier's **entire invalidation path**. Gutted, `invalidateTags` returns
no member keys, the tier deletes nothing client-side, and every Redis-backed deployment serves
pre-write rows until TTL on every publish — with `report.errors` empty and the bust reading as clean.
The first is the fix for the documented unbounded-tag-set outage (`redis.ts:100-114`): with no
`EXPIRE`, `SMEMBERS <ns>:t:{post}` grows without bound again. Both are code the 2026-08-12 audit
shipped as fixes; neither has ever run.

Only one text-shaped mutation is caught (inserting a literal `redis.call('DEL', key)` fails a
*string* assertion about the script, not a behavioural one). And there is **no live Redis suite
anywhere**: `find -name '*.live.test.ts'` returns pg and nats only; CI starts Postgres and NATS,
never Redis.

Fix: add `packages/cache/src/redis.live.test.ts` behind `describe.skipIf(!process.env.TEST_REDIS_URL)`
driving a real `Bun.redis` through set → tag-join → `invalidateTags` → `get` miss, plus
`TTL <bucket>` after two members of different leases. Start `redis:7-alpine` in `ci.yml` beside
`nats-js`. Until then, delete the fakes' mirrored `if` branches and have them fail loudly on an
`EVAL` they cannot execute, so the absence is visible rather than green.

## High

### 3. `packages/core/src/timing-safe-equal.test.ts:5-23` — the only property the module exists for is untested

```
packages/core/src/timing-safe-equal.ts:14
-    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
+    if (a.charCodeAt(index) !== b.charCodeAt(index)) return false;
```

survives **1,106 tests across 90 files** in `core` + `auth` + `storage`, 0 fail. Every test asserts
only the boolean answer, which the mutant preserves exactly. The mutation restores the
character-by-character timing oracle on session tokens, api keys, verification tokens and storage
signatures — the leak `matchesHash`, `takeVerification` and the storage signature check all route
through this one function to avoid.

Fix: a **source-shape assertion**, in the style the repo already uses for the Lua script — read the
file and assert the loop body contains `diff |=` and the function contains exactly one `return false`
(the length guard). A statistical timing test would be flaky and must not be used here.

### 4. `packages/cli/src/verify-tests.ts:210` — the `live` step reports green over a 96.6%-skipped suite

Measured with no `TEST_DATABASE_URL`:

```
live: 4 pass, 114 skip, 0 fail, 17 expect() calls — 118 tests across 17 files
x verify:  live  ok=True  skipped=False  findings=0
```

`applies` is `files.length > 0`, and `x.verify.json`'s ratchet asks the same question — both satisfied
by files that `describe.skipIf` themselves to nothing. A contributor running `bun run verify` locally
gets a green `live` step having exercised 17 assertions out of a suite whose whole purpose is the
database, replication and NATS paths. Same for `pg-vector.live.test.ts`, which `ci.yml`'s comment
claims "REFUSES to skip when the extension is missing" — it is `describe.skipIf(!hasPostgres)` and
skips silently.

Fix: `runParallel`/`runSerial` already capture `bun test`'s output — parse its `N skip` and record a
finding when a step the floor requires ran **zero non-skipped tests**. `X_VERIFY_SUITE_VANISHED`
already exists and its cause ("found nothing for it to check") is exactly right; widen it from "no
files" to "nothing ran".

### 5. Neither tracked app can ever trip the floor, and the deployed demo has three empty suites

`bun run scripts/reference-app-gate.ts` scores `dummy/social-media-clone` at 14/17 with
`live`, `job` and `e2e` **green-by-skip**; file counts are `live: 0`, `job: 0`, `e2e: 0`, `eval: 0`.
A demo shipping realtime and a job queue to a live URL has zero live and zero job tests.

`find . -name x.verify.json` returns **only the repo root** — neither app commits a floor, and
`x new` scaffolds none (`grep x.verify.json` over `packages/cli/src/templates/` is empty). So
`X_VERIFY_SUITE_VANISHED` is unreachable in every generated app: delete a passing `contract` suite,
the step turns skipped, and `reference-app-gate.ts:98` filters `skipped` out of `red`.

Fix: (a) `x new` writes an `x.verify.json` naming the suites its scaffold ships; (b) commit one in
both tracked apps; (c) `reference-app-gate.ts` treats "a step that passed on the last run is now
skipped" as a regression — the mirror of its existing stale-pin rule. Same defect as
[`05-gate-and-scripts.md`](05-gate-and-scripts.md)'s missing-floor finding; fix once, cite both.

### 6. `packages/testing/src/template-db.ts:132-140` — a pre-existing template silently skips every migration

Two uncovered branches. Proven with an injected `SqlRunner`:

```
an EXISTING template   → MIGRATED (existing template) = []     // migrate never called
migrate() throws 'relation "x_jobs" already exists'
                       → HALF-MIGRATED TEMPLATE CLONED ANYWAY
```

`alreadyExists()` is a substring match on the message and the `try` spans **both** `CREATE DATABASE`
and `config.migrate(...)`. On any Postgres that outlives one run — a developer's local server, a
self-hosted CI runner — the template is created once and never migrated again, so every worker
database is a clone of the first run's schema and every live test asserts against a stale one.
Invisible in GitHub CI only because the service container is fresh each run.

Fix: split the two calls. `CREATE DATABASE` in its own try with the `alreadyExists` tolerance;
`config.migrate(...)` outside it, unconditional and un-swallowed — migrations are expected to be
idempotent, which is what the advisory lock is for. (The tier-4/5 sweep reports the same file from the
poisoned-template angle; one fix closes both.)

## Medium

- `packages/testing/src/harness.ts:64-71` — a teardown that throws strands the cloned database:
  `await app.close?.()` rejects and none of `db.drop()`, `resetNetwork()`, `unsealNetwork()`,
  `restoreDeterminism()` run. Proven: `DROPPED = false`. On Postgres that leaks one
  `ultimate_test_template_wN` per failing run. Note `harness.test.ts:13-16` already carries a
  hand-written `afterAll` repairing the *other* half of this teardown for the rest of the process — a
  workaround at the one framework call site rather than a fix, so every generated app using
  `describeApp` inherits the unrepaired version. Fix: `try { … } finally { … }`, plus a test with a
  rejecting `close`. Lands with [`03-tier45-bugs.md`](03-tier45-bugs.md)'s seal/determinism Critical —
  same function.

- `scripts/lib/gated-apps.ts:33-58` — `examples/dummy` has `contract`, `live`, `job` and `e2e` all
  pinned red. Combined with #5, **not one `.live.test.ts`, `.job.test.ts` or e2e test across both
  tracked apps is currently proving anything**, and the framework's own `live` step is 114/118 skipped
  locally. The end-to-end claim for realtime, jobs and the built output rests entirely on CI's
  Postgres/NATS containers running the framework's own 17 live files. No new mechanism needed — this
  is the pin table shrinking — but the test-visibility cost of those pins is recorded nowhere and
  should be.

- `packages/policy/src/evaluate.ts:99` — the `DecisionSink` event's `reason: null` on an **allow** is
  unasserted: mutating it to `'allowed'` survives all 98 tests in `packages/policy`. Sibling fields
  are all covered (`allowed`, `deciding`, `orgId` each fail 1–2 tests), so this is a single gap. Fix:
  `toEqual` on the whole emitted record for an allowed decision.

- `packages/ai/src/fix-line.eval.test.ts` — the framework's only eval scores an `EchoProvider`. It
  proves the eval *machinery*, and the file says so honestly, but no model output is measured anywhere
  in `bun run verify`, so `eval` green means "the scorer works", never "the prompt holds". Fix: reword
  `SUITES.eval.summary` to "eval machinery and recorded baselines", or add one gateway-backed eval
  behind an env guard with the skip-detection #4 asks for.

- `.github/workflows/ci.yml:161` — `scaffold-smoke`'s `x verify` is `continue-on-error: true`, so the
  job described as "the end-to-end promise, proved for real" cannot fail. Also in
  [`11-deploy-ci.md`](11-deploy-ci.md); fix once.

## Low

- `packages/http/src/hooks.test.ts:52-59,60-67` — assertions inside `if (!decision.allowed)` on a
  literal the test itself wrote; the guard is statically true and the test exercises no production
  code. Delete, or move to `type-pins.ts` where the repo puts type-level claims.
- `packages/testing/src/registry-leak-guard.test.ts:125,132,151` — three `expect(1).toBe(1)`. Assert
  the sampled registry directly rather than a tautology that reads as coverage.
- `packages/testing/src/registry-leak-guard.ts:115-121` — the guard's `onLoad` claims `/\.test\.tsx?$/`
  and answers `loader: 'tsx'` (Bun's classic-React JSX), not render's transform. Zero `.test.tsx`
  files exist, so the branch is dead — but the first one added hits the same trap as #1. Restrict to
  `\.test\.ts$`, or route `.tsx` through `transformTsx`.
- `packages/cli/src/verify-tests.ts:49` — the `e2e` filter is the bare substring `'e2e'` matched
  against the whole path; any future directory containing those three characters joins the step. Every
  other type uses a dotted suffix. Fix: `'/e2e/'` plus `.e2e.test.`.

## Coverage holes worth closing

| File | Uncovered behavior | Test to write |
|---|---|---|
| `packages/cache/src/redis.ts:88-124` | both Lua scripts' actual semantics | `redis.live.test.ts` behind `TEST_REDIS_URL` |
| `packages/core/src/timing-safe-equal.ts:13-16` | the branch-free property | source-shape assertion |
| `packages/testing/src/template-db.ts:133-137` | template-exists → migrate skipped; migrate error swallowed | two injected-`SqlRunner` cases |
| `packages/testing/src/harness.ts:64-71` | a throwing `close` strands `drop` | rejecting-`close` boot |
| `packages/policy/src/evaluate.ts:94-106` | the full shape of an allowed sink event | `toEqual` on the record |
| `packages/cli/src/verify-tests.ts:141-165` | an all-skipped step reports green | drive `runType` with a fully-skipped file |
| `scripts/reference-app-gate.ts:98` | passing → skipped is not a regression | app-gate unit test |
| `dummy/social-media-clone` | zero live/job/e2e for a deployed realtime+jobs app | one live-query patch test, one job replay test |

Modules **no test file imports directly** (reached only transitively, if at all):
`packages/jobs/src/driver-pg-rows.ts`, `packages/realtime/src/{subscription-book,query-window,sync-frames,client-frames}.ts`,
`packages/mcp/src/{dev-host,app-tool,input-schema}.ts`, `packages/http/src/finalize.ts`,
`packages/db/src/{sql-scan,snapshot-parse}.ts`, `packages/core/src/image/probe-svg.ts`,
`packages/action/src/stable.ts`. Write `finalize.ts`'s two-pass degradation and
`subscription-book.ts`'s `(socket, sid)` composite key first — both encode a bug the file's own header
says already shipped once, and `subscription-book.ts` is where [`07-security.md`](07-security.md)'s
O(N²) Critical lives.

## Verified sound — do not "fix"

Every 2026-08-12 test finding is genuinely closed (`robots.test.ts`'s conditional assertion,
`x.verify.json` + `X_VERIFY_SUITE_VANISHED`, the new `.job`/`.contract`/`.eval` suites, and all six
priority uncovered clusters now fail under mutation). **No `.only`, no `test.skip`, no `test.todo`**
anywhere in `packages/`, `examples/` or `dummy/`. The "assertion behind an `if`" pattern is
disciplined — 120 sites scanned, essentially all the TS-narrowing idiom where the discriminant is
pinned by the line above. All 33 zero-assertion candidates are false positives (`await x.run()` where
a throw is the failure is an implicit assertion). `sealed-network.ts` has no hole. `fixtures.ts`
handles both dispose symbols and runs every disposer past a throw, with the body's failure winning.
**No flakiness** from wall-clock, ports or network — the preload freezes `Date`, seeds `Math.random`
and seals `fetch`; three consecutive runs were byte-identical. The app-gate ratchet is sound in the
direction it was built for; only passing→skipped is open.

## Done when

- `bun run test` and `x verify`'s unit step agree, and both are green — the 26 failures are fixed, not
  sharded around.
- Gutting either Lua script fails a test.
- A step whose suite runs zero non-skipped tests is a finding, not a pass.
- Both tracked apps commit an `x.verify.json`, and `x new` scaffolds one.
- `bun run verify` green.
