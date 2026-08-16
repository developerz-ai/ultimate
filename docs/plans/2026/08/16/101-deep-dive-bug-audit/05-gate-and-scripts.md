# 05 — The gate lies

> Part of [`overview.md`](overview.md). Depends on: none. Tier: scripts + `cli` (5).

Land this slice **first**. Every other slice ends at "`bun run verify` green", and two of the gate's
own checks provably do not check what they claim — so a green gate is not yet evidence.

`bun run verify --json` is genuinely green today: 14 of 17 passed, 3 skipped (`drift`,
`contract-diff`, `budgets`, all three legitimately inapplicable at a non-app root and correctly
omitted from `x.verify.json`'s floor). The defects below are holes *inside* passing steps.

## Critical

- `tsconfig.json:6` — **`scripts/` is in no project reference, so `x verify`'s `typecheck` step never
  typechecks the gate's own implementation.** `bun run typecheck` is `tsc -b`, which builds only
  referenced projects; `scripts/tsconfig.json` exists but sets `composite: false` (so it *cannot* be
  a reference) and no `references` entry names it. `scripts/verify.ts`, `boundaries.ts`,
  `manifest.ts`, `reference-app-gate.ts`, `release.ts`, `roadmap.ts` and `error-render.ts` compile
  nowhere. **Proven**: `export const probe: number = 'definitely not a number'` dropped into
  `scripts/zz-audit-probe.ts` → `bunx tsc -b --pretty false` exited **0**. Compiling the project
  directly reports **7 real pre-existing errors**: `scripts/lib/framework-manifest.ts:97-102` (6 ×
  TS4111) and `scripts/list-workspaces.ts:24` (TS2345). Fix: give `scripts/tsconfig.json`
  `"composite": true` (drop `noEmit`, or emit to a scratch `outDir`), add `{ "path": "./scripts" }`
  to the root `references`, then fix the 7 errors.

  The hole is structural, not a one-off: **nothing enforces that a workspace joins the root build
  graph.** `scripts/new-package.ts` writes a package's `tsconfig.json` and never adds it to the root
  `references`, and `checkPackageShape` has no such rule — only the two gated apps are checked, via
  `X_REFERENCE_APP_UNREFERENCED`. Add a `package-shape` rule that every non-private workspace appears
  in the root `references`.

## High

- `scripts/list-workspaces.ts:24` — `allowedTiersFor` is handed a package *directory name* where a
  *tier number* is required, so `bun run workspaces:list` reports `may import 0-NaN` for all 29
  workspaces. `allowedTiersFor(tier: number)` returns `` `0-${Math.max(tier - 1, 0)}` `` and
  `"core" - 1` is `NaN`. `scripts/lib/tiers.ts:66-68`'s doc block records that the signature was
  deliberately changed from name to tier; this call site was never updated — and the typecheck gap
  above is exactly why nobody saw it. Proven. Fix: `allowedTiersFor(workspace.tier)`. This is one of
  the 7 errors the Critical unblocks.

- **Neither tracked app commits an `x.verify.json` suite floor** — `examples/dummy/` and
  `dummy/social-media-clone/`. `readVerifyFloor` (`packages/cli/src/verify-floor.ts:67-69`) returns
  `undefined` when no file exists ("no file is no floor"); `runVerify`
  (`packages/cli/src/cmd-verify.ts:270-284`) records a non-applying step as `ok: true, skipped: true`;
  and `scripts/reference-app-gate.ts:98` defines `redSteps` as `!(step.ok || step.skipped)` — **a
  skipped step is not red**. So deleting an entire suite in either gated app (`contract`, `live`,
  `job`, `e2e`, `eval`) turns its step from red-and-pinned into skipped-and-green: neither a
  regression nor a stale pin, and both gates stay green. The framework root closed exactly this hole
  with its own `x.verify.json`; the two apps it blocks on did not get one. Fix: commit
  `x.verify.json` in both app roots naming the steps each has proved it can run, and make `redSteps`
  treat a *skipped* step that `expectedRed` pins as still-pinned rather than stale.

## Medium

- `scripts/boundaries.ts:78` — `dropTypeKeyword`'s regex removes only the `import type` /
  `export type` **keyword form**, so an all-inline-type specifier list is invisible to the tier check.
  Proven: `allImportsOf({source:"import { type A } from '@ultimat3/cli';"})` → `[]`, same for the
  `export` form; the mixed form (`import { A, type B }`) *is* seen. A tier-0 → tier-5 edge spelled
  `import { type Foo } from '@ultimat3/cli'` passes `bun run boundaries` clean — contradicting the
  file's own doc block ("The tier rule applies to both — a type-only edge still couples two packages'
  release cycles"). Medium not High because `biome.json:43-44` (`useImportType`/`useExportType:
  error`) rewrites the all-inline form, so landing it takes a lint bypass. Fix: after
  `dropTypeKeyword`, strip inline `type ` inside specifier braces, or scan with `Bun.Transpiler`
  twice — once normally, once with all `type` modifiers erased.

- `scripts/boundaries.ts:189` vs `packages/cli/src/source-files.ts:5-17` — the `errors` step's two
  halves disagree on what "source" is. `checkErrorFixes` walks `SOURCE_GLOBS`, which includes
  `scripts/**`; `errorRendering` (the `X_ERROR_RENDER_UNSAFE` half, `scripts/error-render.ts:369`)
  walks `collectSourceFiles`, whose `SOURCE_PATTERNS` are `packages/*/src` + `packages/*/e2e` only.
  The 16 `X_*` codes declared under `scripts/` are held to the fix-line rule but **not** to the
  render-safety rule — contradicting `source-files.ts`'s own header ("One list for every step that
  walks source, because two steps scanning different sets means a finding one of them can never
  see"). Fix: add `'scripts/**/*.{ts,tsx}'` to `SOURCE_PATTERNS`.

## Low

- `scripts/setup.ts:47` — `X_SETUP_INSTALL_FAILED`'s `fix:` is
  `rm -rf node_modules bun.lock && bun install`, which **deletes a committed lockfile** in a
  lockstep-versioned monorepo; an agent running it verbatim regenerates the lock and silently changes
  resolved versions. Fix: `rm -rf node_modules && bun install --frozen-lockfile`.

## Verified sound — do not "fix"

| Suspicion | Result |
|---|---|
| `x verify` swallows exit codes | no — `exec.ts` sets `ok: code === 0`; a SIGKILLed child returns 137 (proven); every shard's non-zero exit becomes `X_TEST_SHARD_FAILED` |
| an env var narrows the step set | no — `bunfig.toml`'s three `ULTIMATE_TEST_*` vars affect determinism, not selection |
| `--unpin` is broken | no — proven against the live pins file for both apps, single-step and all-steps; `report()` exits before the gate can re-run |
| the ratchet can be satisfied while a pinned step passes | no, at step level — the gate is green with all 10 pins genuinely red |
| manifest drift detection is incomplete | no — `bun run manifest && git diff` produces nothing |
| `roadmap` misreports | no — 12 milestones, all marked, all shipped artifacts present (but see [`11-deploy-ci.md`](11-deploy-ci.md): milestone 11's evidence is existence-only over two files that do not work) |

## Tests

- `scripts/verify.test.ts` — an injected type error under `scripts/` fails `bun run typecheck`. This
  is the test that would have caught the Critical.
- `scripts/boundaries.test.ts` — `import { type A } from '@ultimat3/cli'` in a tier-0 file is a
  violation; the `export` form likewise.
- `scripts/reference-app-gate.test.ts` — a pinned step that becomes *skipped* is reported, not
  treated as satisfied.
- `scripts/new-package.test.ts` — a new package appears in the root `tsconfig.json` references.

## Done when

- `scripts/` is in the root build graph, its 7 existing errors are fixed, and an injected error fails
  the gate.
- Both tracked apps carry an `x.verify.json`, and a deleted suite in either one turns the app gate
  red.
- A type-only cross-tier import is a `boundaries` violation.
- `bun run verify` green — and now meaning what it says.
