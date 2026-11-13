# 16 — The gate, CI and images: the same verdict in less time

> Part of [`overview.md`](overview.md). Depends on: [`13`](13-cli-exercise-verify.md) X6 (the plan file `ci.yml` adopts). Tier: `scripts/`, `.github/`, `docker/`.

Owner goals (2026-10): free runners only, CI under 5 minutes, several deploys a day. Measured locally 2026-11-11 (12 cores, shared): `errors` 24.3 s, `manifest` 27.0 s, `boundaries` 15.8 s, `unit` 354 s (38,360 tests, 9 workers). CI reports `manifest` 99 s and `errors` 96 s.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| G1 | P2 | confirmed (measured) | `scripts/verify.ts:136-178,297-308,357-387` | Host checks run strictly one after another (10 in `errors`, 29 in `manifest`, ~15 in `boundaries`); most are independent and each re-walks the tree | `Promise.all` per step, keeping readme-fence before wiki-fence (they share a tsc program); the finding set and its order (sorted) unchanged |
| G2 | P2 | confirmed (measured: 4,300 ms) | `scripts/keyed-hasher.ts:55-58` | Runs `maskLiterals` and `stripComments` on all 9,434 corpus files with no substring prefilter and ignores the corpus cache, for a rule that matches a few files | `if (!source.includes('CryptoHasher')) return []`; read `file.masked` |
| G3 | P2 | confirmed (measured: 5,810 ms) | `scripts/boundaries.ts:91-103,111-133`; `scripts/lib/corpus.ts` | `checkBoundaries` parses the imports of every file; a file with no `@ultimat3/` specifier cannot violate the tier table. 41 scripts mask sources themselves; 24 use the shared `corpus()` | prefilter on `source.includes('@ultimat3/')`; `masked`/`stripped` become lazy memoised fields on the corpus `SourceFile`; every text rule moves onto `corpus()` (one mask per file per process, held by a test) |
| G4 | P3 | confirmed (measured: 1,944 ms; 721 ms) | `scripts/i18n-catalog.ts` (`frameworkCatalogFindings`), `scripts/seal-calls.ts` | Own tree walks inside the `boundaries` step | onto `corpus()` with a prefilter |
| G5 | P2 | confirmed | `scripts/verify.test.ts:353-363` | The `unit` step re-runs `tierBoundaries`, `frameworkManifest`, `errorCodeDocs`, `checkRoadmap` on the real tree: ~22 s the gate steps already spend. The slowest unit file (33.5 s), run again in the `packages` coverage job | delete the real-tree case; the gate steps are that assertion. Fixture-directory cases stay |
| G6 | P2 | confirmed (read + git log) | `.github/actions/setup/action.yml:139` | The bun cache key is `hashFiles('bun.lock')` with no `restore-keys`; the lock changes on every release (7 times in two days), so each is a cold ~168 MB install on every job | `restore-keys: bun-${{ runner.os }}-`. `ci-workflow-shape.test.ts` asserts it (the scaffolded workflow already has it) |
| G7 | P2 | confirmed (read) | `examples/dummy/docker/Dockerfile:17-20`, `dummy/social-media-clone/docker/Dockerfile:16-20` | The deps stage copies all of `apps/` and `packages/` before `bun install`: every source edit busts the install layer. The scaffold template (`packages/cli/src/templates/scaffold-container.ts:37-48`) copies manifests only | re-emit both from the template; a guard holds a tracked app's Dockerfile to the template's deps stage (`scripts/dockerfile-template.ts`, new, header documented by `guards-doc.ts`) |
| G8 | P2 | plausible | `dummy/social-media-clone/docker/Dockerfile.monorepo` + `.dockerignore` | The deployed image `COPY . .` the whole monorepo and installs every workspace's production dependencies | `bun install --filter` over the app's workspace closure; narrow the ignore file; the container job records the image size and asserts a ceiling (a measurement: raise it with the reason in the same diff) |
| G9 | P3 | plausible | `.github/workflows/ci.yml:532` | `reference-app-verify` caches only the PGlite snapshot; `.x/cache/islands` is content-addressed and rebuilt cold for three apps every run | cache `<app>/.x/cache/islands`, keyed on `bun.lock` + a hash of the island sources |
| G10 | P3 | confirmed (measured) | `packages/cli/src/runtime-queue.test.ts:37-130` (22.6 s: 8 PGlite boots); `examples/dummy/type-chain.test.ts:7-16` (31.8 s: tsc twice, and a header claiming the Postgres driver is unbuilt) | Slow by construction | restore from `pglite-snapshot.ts`; one tsc build-info, header rewritten, hops 5+ pinned |
| G11 | — | from [`13`](13-cli-exercise-verify.md) X6 | `.github/workflows/ci.yml` (`gate` matrix) | A hand-written matrix | read `x verify plan --parts <n> --json` through `fromJSON`; `ci-workflow-shape.test.ts` keeps holding the result |
| G12 | P2 | absent (catalogue) | `.github/workflows/ci.yml` | Nothing finds a flaky test before it merges (retries and quarantine are decided out, `docs/architecture/14-testing-internals.md:195`) | one job: the PR's changed test files with `--rerun-each 5` (`scripts/lib/bun-test-paths.ts:12`); red if any run differs. Changed files only |
| G13 | **P1** | partial (catalogue) | `scripts/deprecation-window.ts:1`, `scripts/lib/export-names.ts:1` | Semver covers the public surface, and the only check is a *name removed* from a package's main `src/index.ts`. Subpath entries (`/outbound`, `/adapter`, `/page`, `/redis`, `/schema-dump`, `/diagnostics`) and every **signature** change are unguarded | `scripts/public-api.ts`: emit `.d.ts` per package entry and subpath, normalise, hash each exported symbol's declaration into `scripts/lib/public-api.lock.json`; a changed or removed symbol with no `BREAKING —` changelog entry is refused on `main`: `X_PUBLIC_API_BREAK_UNDECLARED`, on the `manifest` step. An additive change updates the lock with `--write` |
| G14 | P3 | confirmed | 30 files at 449–500 LOC (`packages/cli/src/prerender.ts` 500, `cli/src/errors.ts` 493, `cmd-deploy.ts` 492, `packages/testing/src/island-dom.ts` 491, `scripts/verify.ts` 487) | At the ceiling: the next edit forces a split mid-feature | split each when this plan touches it; `scripts/verify.ts` splits in this slice (G1 adds to it) |

Checked and fine, not planned: the gate/CI parts-and-merge design, `x ci tested` reuse, the prose-only `changes` skip, `release.yml` gating on the whole run, the framework Dockerfile (distroless, non-root, manifests-only deps stage), zero TODO/FIXME markers in scope. Benches stay out of the gate (`.github/workflows/bench.yml:6`).

Not reached: whether each guard in `docs/architecture/guards.md` can run on changed files only. Planned as a measurement in step 5, not as work.

## Files to change
- `scripts/verify.ts` (split: `verify-host-checks.ts`), `scripts/lib/corpus.ts`, `scripts/boundaries.ts`, `scripts/keyed-hasher.ts`, `scripts/seal-calls.ts`, `scripts/i18n-catalog.ts`, and the ~17 scripts that mask on their own — G1–G4.
- `scripts/verify.test.ts` — G5.
- `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `scripts/ci-workflow-shape.test.ts` — G6, G9, G11, G12.
- `examples/dummy/docker/Dockerfile`, `dummy/social-media-clone/docker/Dockerfile`, `Dockerfile.monorepo`, `.dockerignore`; `scripts/dockerfile-template.ts` + test — G7, G8.
- `packages/cli/src/runtime-queue.test.ts`, `examples/dummy/type-chain.test.ts` — G10.
- `scripts/public-api.ts`, `scripts/public-api.test.ts`, `scripts/lib/public-api.lock.json` (new, generated) — G13.
- Coordinator only: `bun run new-error-code X_PUBLIC_API_BREAK_UNDECLARED --package cli … --off-socket`, `guards-doc.ts --write`, `bun run manifest`.

## Steps
1. Before: record each root step's wall-clock from three CI runs on `main` (`gh run view --json jobs`). That table goes in the PR.
2. W1 G1–G4 (the corpus: one worker, it is one data structure); W2 G5, G10, G14; W3 G6, G9, G11, G12 (`ci.yml` is one file: one worker); W4 G7, G8, then G13.
3. G1's safety net: run the serial and the parallel host checks on the same tree and diff the sorted findings — in a test, on fixtures with a planted finding per check.
4. G13 lands report-only for one release (the lock is generated from the current tag), then becomes an error. Its first run will list every undeclared signature change since v31: fix the changelog or revert the change.
5. Measure which guards read only the changed file (no cross-file state). If the local `--changed` saving is under 5 s after G1–G4, drop the idea and write that down.

## Tests
- `scripts/verify-host-checks.test.ts` — serial and parallel finding sets equal on a fixture tree.
- `scripts/lib/corpus.test.ts` — a file is masked once per process; the prefilters keep every planted finding.
- `scripts/ci-workflow-shape.test.ts` — `restore-keys` present; the matrix equals the plan; the rerun job exists and names changed files only.
- `scripts/dockerfile-template.test.ts` — a deps stage that copies sources is red.
- `scripts/public-api.test.ts` — a changed parameter type on a subpath export with no `BREAKING —` entry is red; an added export is green after `--write`.
- Commands: `bun test ./scripts/<file>.test.ts`; `bun run verify`.

## Done when
- `errors` + `manifest` + `boundaries` under half their recorded CI wall-clock (table in the PR).
- A release commit no longer cold-installs on every job.
- A source edit to a tracked app rebuilds its image without re-running `bun install`.
- A signature change to any exported symbol cannot reach `main` undeclared.

## Outcome (16, local)

Ships as 31.19.0. `As of 2026-11-13`, measured before the first CI run of the branch; the CI before-table (three `main` runs) goes in the PR.

| ID | Outcome |
|---|---|
| G1 | shipped. `scripts/verify-host-checks.ts` runs each step's checks concurrently (`lib/host-check-run.ts`), keeping list order and the first-failing throw; `verify-host-checks.test.ts` holds serial and parallel equal on a fixture tree with a planted finding per check. Local, shared 12-core machine: `boundaries` + `errors` + `manifest` 67.1 s (plan baseline) → 38.1 s and 45.1 s in two runs (a third, beside other load, 89 s). The Done-when figure is CI's, owed from the branch's first run. CI's first runs were slower (`gate (static)` 93 s against 55-66 s on main): each TypeScript 7 `tsc` is threaded, and the three compiler chains at once oversubscribed a 4-vCPU runner (`lint`, unchanged, 15-19 s → 26-43 s). The four `tsc` checks now share `compilerWidth()` slots, one per four CPUs. The static part's `--only` list, 2026-11-13, shared host: `taskset -c 0-3` 67-72 s against main's 77-86 s; all 12 cores 47-63 s against main's 67-72 s |
| G2 | shipped. `keyed-hasher` returns before masking a file that never spells `CryptoHasher`, and reads the corpus file's `masked` |
| G3 | shipped for the `boundaries`, `errors` and `manifest` steps. `masked` / `stripped` are lazy, memoised fields of a corpus file; the tier table reads a parse-free bound (`reachableTargets`) and parses only a file it cannot clear (`boundaries-reach.test.ts`); `corpus.test.ts` counts one mask per file per process. **Deferred:** ~20 unit-only guards still mask files themselves |
| G4 | shipped. `seal-calls` and the framework catalog scan read the corpus behind a prefilter (`mayNameKeys`: 2,657 of 5,431 files pass). `i18n`'s `extractKeys` still strips twice: deferred |
| G5 | shipped. The real-tree case in `verify.test.ts` is gone; a test pins each step to the check by identity |
| G6 | shipped differently, **premise false.** The plan's fix (`restore-keys: bun-${{ runner.os }}-`) is exactly what `.github/actions/setup/action.yml` had removed on purpose: the prefix fallback restored the previous lock's cache and saved both, so the entry grew 34 → 168 → 287 MB (`docs/history/ci-split.md`). Instead the key is a digest of `bun.lock`'s `"packages"` section, which a release does not touch (identical across 31.17.0 and 31.18.0). `ci-workflow-shape-caches.test.ts` runs the key step on a bumped and on a moved lock |
| G7 | shipped. Both tracked Dockerfiles are the template's: a manifests-only `manifests` stage, `deps` installing from it, runtime `FROM deps`, `USER 1000:1000`. `scripts/dockerfile-template.ts` (`X_DOCKERFILE_DEPS_DRIFT`, `boundaries` step) refuses drift in the install stages; `--write` splices |
| G8 | partial, **premise half false.** `bun install --filter` over the demo's closure saves nothing (measured: the same 74 packages, 58 MB — the closure is every framework package but `create-ultimate`), so it is not used and the Dockerfile says why. The ignore file now drops the sources outside the closure. The `container` job builds the image and holds its file system under 223,000,000 B. **Owed:** the job's added wall-clock, from the first CI run |
| G9 | shipped. `reference-app-verify` caches `<app>/.x/cache/islands`, keyed on `bun.lock` and the island sources |
| G10 | shipped, **premises partly false.** `runtime-queue.test.ts` booted 5 PGlites (five `startQueue` sites), not 8; it now pays `initdb` and the framework schema once and boots each test over a copy of that directory, not from `pglite-snapshot.ts`: 22.6 s → 7.1 s. `type-chain.test.ts`: one shared build-info measured no saving (a rename at either root rechecks nearly the whole app), so the fix is dropping the baseline run instead — the app's sources typecheck clean, so every in-app diagnostic is the rename's. Its second compiler run now renames the view field and pins hops 5+. 31.8 s → 18.3 s, under a concurrent gate run. Header rewritten (the Postgres driver is built). The column rename's pins: 12 files, 31 diagnostics (`docs/architecture/05-type-chain.md` rewritten to match) |
| G11 | shipped. The `gate` matrix is `fromJSON` of `x verify plan --parts 7 --json`, run in `tested`; `x verify plan` now answers outside an app (`cmd-verify-plan.test.ts`) |
| G12 | shipped. `flaky` (pull requests only) reruns the changed unit/contract/job test files `--rerun-each 5`, at most 40 (`scripts/lib/ci/rerun-changed.ts`) |
| G13 | shipped report-only, as step 4 says. `scripts/public-api.ts` hashes 9,995 symbols (~4 s) into `scripts/lib/public-api.lock.json`; `X_PUBLIC_API_BREAK_UNDECLARED` / `X_PUBLIC_API_UNSCANNED` are warnings on the `manifest` step, red under `--strict`. `release.ts --bump` rewrites the lock after promoting the changelog (`release-api-lock.test.ts`). **Owed:** one entry in `REFUSE_ON_BRANCHES` once a release has run with it |
| G14 | partial. `scripts/verify.ts` 490 → 144 lines (`verify-host-checks.ts` 389). The other files at the ceiling were not touched by this slice |

Integration decisions:

- The plan's `new-error-code X_PUBLIC_API_* --package cli --off-socket` was wrong twice: `--off-socket` is refused for a tier-5 package, and a code registered in `@ultimat3/cli` that only `scripts/` throws is `X_ERROR_CODE_UNTHROWN`. All three new codes are gate-only: a hand-written row in `wiki/Error-Codes.md` and an entry in its never-ship list, like `X_LOG_LEVEL_*`.
- Step 5 (`--changed` guards) was not measured.
