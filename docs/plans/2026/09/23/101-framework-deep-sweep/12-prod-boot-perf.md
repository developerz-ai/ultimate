# 12 — production boot carries no dev or test code

> Part of [`overview.md`](overview.md). Depends on: 01 (dev-secret assertion), 06. Tiers: 3 (realtime), 5 (cli, testing).

Rule: what a container runs is named for production and imports nothing from `@ultimat3/testing`,
`templates/`, `e2e-*` or `cdp-*`. That becomes enforced by a bundle-graph test (row f).

Evidence (measured 2026-09-23, `bun build --metafile`):
- The scaffold's `apps/web/server.ts` imports `runRole` from the `@ultimat3/cli` barrel, which is **1,349 modules**, including 60 templates and 17 e2e/cdp modules.
- `serve.ts` alone is 792 modules, 38 of them from `@ultimat3/testing`, via `serve.ts:37` → `dev-roles.ts:39` → `dev-live-feed.ts:15` `startLiveReplicator`. This breaks the rule stated at `app-load.ts:51-56`.
- `x --help` loads 1,259+ modules in 0.9 s and 145 MB (babel 410 ms, sass 538 ms).
- Every boot compiles every island: import 1.29 s, build 1.99 s.

## Files to change

| # | Change | File:line | Semver |
|---|---|---|---|
| a | Move `startLiveReplicator` to `@ultimat3/realtime/server` (it imports only `entity` and `realtime`, so it is a second `ChangeFeed` driver). `testing` re-exports it until 22.0.0 (slice 18) | `packages/testing/src/live-replicator.ts` → `packages/realtime/src/live-replicator.ts`; `packages/cli/src/dev-live-feed.ts:14-15` | minor |
| b | Add an `@ultimat3/cli/serve` subpath exporting `runRole` and nothing else. The scaffold's `server.ts` template and both tracked apps import it | `packages/cli/package.json` `exports`, `packages/cli/src/serve.ts`, `templates/scaffold-container*.ts` / server template, `examples/dummy/apps/web/server.ts`, `dummy/social-media-clone/apps/web/server.ts` | minor |
| c | Rename the `dev-*` modules production runs (`dev-roles`, `dev-sync`, `dev-queue`, `dev-render`, `dev-runtime`, `dev-live-feed`, …) to `role-*` / `runtime-*`, so filenames answer "what runs in prod". Mechanical: `git mv` plus imports | `packages/cli/src/dev-*.ts` imported by `serve.ts:32-42` | none (internal) |
| d | Lazy command registry: `SPECS` and help stay static, and the command body is `await import()`ed on dispatch. `sass` loads lazily in `compileStylesheet`, babel in `solidJsxPlugin` | `packages/cli/src/registry.ts:4-34` | none |
| e | Cache island chunks in the image, keyed on the existing `graphHash`: `x build --target docker` writes them, and boot verifies rather than rebuilds. Roles that serve no HTTP (`worker`, `scheduler`, `replicator`, `migrate`) skip `buildIslands` entirely | `packages/cli/src/serve.ts:361` (`bootRoles`), `cmd-build.ts` | minor |
| f | Pass `--build-arg BUILD_ID` from `x build --target docker`, so replicas do not hash the manifest at boot | `packages/cli/src/cmd-build.ts:60-61` | patch |
| g | Production reads the error pages once at boot, not per error response | `packages/cli/src/error-pages.ts:41` | patch |
| h | `serve.ts` calls 01 e's `assertNoDevSecretsOutsideLocal()` and 02 j's storage check at boot | `packages/cli/src/serve.ts` | patch |
| i | Graph test: bundle `@ultimat3/cli/serve` with `--metafile` and assert that no input path matches `packages/testing/`, `/templates/`, `/e2e-` or `/cdp-`, and that the module count is under a pinned ceiling (the measured value + 10%, with the number and reason in the diff per axiom 9). This is what makes the rule a build error | `packages/cli/src/serve-graph.test.ts` (new) | none |

## Steps
1. a, then b, then i (the test goes red before b and green after).
2. c is a separate mechanical PR, so review diffs stay readable.
3. d: measure `time bun run x -- --help` before and after, and state both in the PR. `compile-externals.ts:33` notes that a lazy import does not shrink the `--compile` binary, which is fine; this change targets load time.
4. e: prove that "same chunks as dev" still holds. An existing test compares dev and build chunk hashes; extend it to the cached path.

## Tests
- `bun test packages/cli/src/serve-graph.test.ts packages/cli/src/serve*.test.ts packages/realtime/src/live-replicator*.test.ts`
- `bun run boundaries` (the realtime move adds no upward edge).
- CI `container` job (the image still ends in `/app/x --version`).

## Done when
- The graph test is green with zero testing, template or e2e modules.
- `x --help` runs in under 0.2 s.
- A worker pod boots without compiling islands.
