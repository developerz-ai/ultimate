# 08 — Scaffold and agent DX

> Part of [`overview.md`](overview.md). Depends on: 07 (`drift`, `i18n sync`, `--help`). Tier: 5 (`packages/cli/src/templates/`).

All findings here were reproduced on a fresh `x new` against the **published** 7.0.0 packages from npm (`bun install` resolved `@ultimat3/*@7.0.0`, not workspace links).

## Files to change
- `packages/cli/src/templates/scaffold-repo.ts:170` — the scaffold's `biome.json` `includes` excludes `migrations`, `x.manifest.json`, `openapi.json` and **not `.x/`**. `x build` writes minified island bundles under `.x/static/islands/`; `lint` then reports 175 `noCommaOperator`/`noAssignInExpressions` errors in Bun's output. **Proven** chain on a pristine scaffold: `verify` → `x db gen` → `x build` (the `budgets` fix) → `verify` red on `lint` → `bunx biome check --write .` (its fix) → exit 1 → red forever; `--unsafe` **rewrote the content-hashed chunk in place** (55,499 → 83,605 B), so an agent that follows the fix chain and then `docker build` ships an artifact whose name no longer matches its bytes and whose size no longer matches `.x/build-stats.json`. The framework's own `biome.json` has `"!**/.x"` and `vcs.useIgnoreFile: true`; the template has neither. `--no-example` hides it (no islands), which is why `scaffold-smoke` is green.
- `packages/cli/src/templates/scaffold-db-package.ts:60` — writes "This list is what the migration generator reads, so an entity that is not exported here does not exist as far as the database is concerned" into every app. False: `x db gen` reads the registry. Delete the claim (slice 07 makes `drift` read the registry too).
- `packages/cli/src/templates/` (AGENTS.md template) — nine non-negotiables, five unenforced. **Proven**, each green on `x verify`: a hardcoded JSX string beside a `t()` call; `color: #ff0000` in `page.module.scss` (whose scaffolded header says "a raw hex here is … a lint failure" — `templates/route.ts:141`, `island.ts:81`); `toLocaleDateString('en-US')` with no `timeZone`; `t.number` money with `19.99 * 1.21`; `throw new Error(...)` in `repo.ts`. `verify-checks.ts:62` says the colour rule rides on `packages/ui/src/tokens/tokens.test.ts` — which covers the framework's stylesheets, not the app's. The mechanism that would enforce them exists and is good: `guards/`, discovered not registered, run inside `boundaries`; **`x new` ships zero guards**.
- `packages/cli/src/cmd-new.ts` — never runs `git init`; `X_ROUTE_FILE_INVALID`'s fix is `git mv` (exit 128 in a fresh scaffold), `x affected` / `x ci` / `x pr` all fail on "not a git repository". **Proven.**
- `.github/workflows/ci.yml` `scaffold-smoke` — runs `x new` → `bun install` → `x verify` and stops. It never runs `x db gen`, never runs `x build`, and never follows a printed `fix:` — the only step that would have caught the loop above. Issue #121's closing paragraph still holds.

## Steps
1. `scaffold-repo.ts:170`: `includes` adds `"!**/.x"`, `"!**/dist"`, `"!**/.output"`; add `"vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true }` — copy the framework's own `biome.json`.
2. Ship four guards under `guards/` from `x new`, each ~30 lines in the `billing-guard.ts` shape: raw colour literal in `**/*.scss` (`#hex`, `rgb(`, `hsl(`, named colours); `Intl.DateTimeFormat`/`toLocale*String` without a `timeZone` key; `throw new Error` outside `*.test.ts`; JSX text nodes with ≥2 word characters outside `{t(…)}` under `site/` and `app/`. Each names an `X_*` code already in the tree where one exists, else a new `X_GUARD_*` code in `@ultimat3/cli`. Money-as-float has no static signature — drop that row from the scaffolded `AGENTS.md` or point it at the `Money` type error that already fires.
3. Delete the `schema.ts` claim (`scaffold-db-package.ts:60`); leave the re-export file as the optional "pin an entity's order" surface, or delete it if nothing reads it after slice 07.
4. `x new`: `git init && git add -A && git commit -m "x new"` by default, `--no-git` to skip; or change `X_ROUTE_FILE_INVALID`'s fix to plain `mv` when `.git` is absent. Do both — `x affected`/`x ci` need the repo.
5. `scaffold-smoke`: after `x verify` red, parse `--json`, run each `fix:` verbatim, re-run `x verify`; assert green within 3 rounds, on both default and `--no-example` scaffolds; then `x build --target static` and assert `lint` stays green; then `x db migrate` against the job's Postgres service. This is the assertion `scripts/scaffold-gate.ts` should own (slice 09 adds `declaredStepIssues` there).
6. Fix `x new --help`: usage and flag table agree; state the default.

## Tests
- `packages/cli/src/templates/scaffold-repo.test.ts` — the emitted `biome.json` excludes `.x`.
- `packages/cli/src/cmd-new.test.ts` — scaffold contains `guards/*.ts` (4 files) and `.git` (unless `--no-git`).
- `scripts/scaffold-first-run.ts` (exists) — extend: introduce each of the five mistakes into the scaffold and assert `x verify` reds with the named code.
- Command: `bun test packages/cli/src/cmd-new.test.ts packages/cli/src/templates`, then `bun run scripts/scaffold-gate.ts` outside the checkout.

## Done when
- On a fresh scaffold in a temp dir: `x new` → `bun install` → `x verify --json` → follow every `fix:` → green, default and `--no-example`, without `rm -rf .x`.
- Each of the five injected mistakes reds `x verify` with a code and a runnable `fix:`.
- `scaffold-smoke` in CI performs the fix-follow loop.
