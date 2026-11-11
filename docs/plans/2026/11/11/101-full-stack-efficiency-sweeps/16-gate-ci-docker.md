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
