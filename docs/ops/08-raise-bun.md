# Raise `.bun-version` and the Bun floor

**Every Bun pin site names one patch, the floor included, so moving the pin IS moving the floor —
a breaking change that lands on `next`, never on `main`.** `scripts/bun-pin.test.ts` ("every site
that names a patch names the one CI runs") holds `.bun-version`, CI, the release job, both images,
`@types/bun` and every `engines.bun` to one patch; [`wiki/Stability.md`](../../wiki/Stability.md)
moves the floor only in a scheduled major or by the security exception. Precedent: 28.0.0 (1.4.3)
and 29.0.0 (1.4.4), each `BREAKING — (#1) Bun <patch> is the floor.`

**Rehearsal:** last run for real for 29.0.0 (`chore(toolchain)!: Bun 1.4.4 — every pin site, and
the floor with them (#917)`). Not re-run in sweep 8a: `As of 2026-11-15` no newer stable exists —
`npm view bun version` and `gh api repos/oven-sh/bun/releases/latest --jq .tag_name` both answer
1.4.4 (`bun-v1.4.4`, 2026-10-22), equal to `.bun-version`.

## 0. Is there one, and which lane

| Question | Command | Answer |
|---|---|---|
| a newer stable | `npm view bun version` against `cat .bun-version` | equal: stop here |
| what changed in it | `gh release view bun-v<new> --repo oven-sh/bun` | read it whole; a bundler or transform change moves bytes and coverage (29.0.0's notes list both) |
| is the major window open | the `Next major window` line of `wiki/Stability.md` | open: the break rides the next major from `next`. Closed: it waits on `next` |
| is it a security fix | a first-tier advisory naming Bun | yes: the exception, `bun run scripts/release.ts --bump major --security GHSA-xxxx-xxxx-xxxx --dry-run --json` |

Branch from `next`. `git ls-remote origin next` empty means the lane does not exist yet: stop and
say so; never put the floor on `main` (`X_BREAKING_ON_MAIN`).

## 1. Move every site

| Site | What to write |
|---|---|
| `.bun-version` | `<new>` |
| `.github/actions/setup/action.yml`, `.github/workflows/release.yml` (both jobs) | `bun-version: '<new>'` |
| `scripts/setup.ts` | `REQUIRED_BUN = [<major>, <minor>, <patch>] as const` |
| `packages/cli/src/app-root.ts` | `REQUIRED_BUN = '<new>'` — the floor `x` and `x doctor` enforce (`X_BUN_VERSION`), and what `x new` writes into a scaffold's `engines.bun` |
| `engines.bun` in the root `package.json` and every `packages/`, `examples/`, `dummy/` manifest | `>=<new>` |
| `@types/bun` in the root `package.json` | `<new>` |
| `docker/Dockerfile` | every `FROM oven/bun:<series>-slim@<digest>`, and the `The digest is` comment naming `oven/bun:<new>-slim` |
| `packages/cli/src/templates/scaffold-container.ts` and `packages/cli/src/templates/bun-image.ts` | the `-alpine` digest and its recorded tag; `bun-image.test.ts` holds the two equal |
| each tracked app's `docker/Dockerfile*` | the same `FROM` lines |

Read each digest, never copy one: `docker buildx imagetools inspect oven/bun:<new>-slim` and
`docker buildx imagetools inspect oven/bun:<new>-alpine` — the `Digest:` line.

`bun test ./scripts/bun-pin.test.ts` is the checklist: red names every site still on the old patch,
and every page that states a different floor.

## 2. Install and re-measure

| # | Step |
|---|---|
| 1 | `bun upgrade` (installs the newest stable — the `<new>` above), then `bun --version` |
| 2 | `bun install`, then `bun run lockfile` — clean, else `bun run lockfile:fix` |
| 3 | `bun test ./scripts/bun-pin.test.ts` green |
| 4 | `bun run coverage` — a Bun that counts functions differently moves a ratio with no code changed (29.0.0: `packages/jobs` 95.46% → 94.59%). A new pin carries the measured numbers in its `why` |
| 5 | bytes: a bundler change moves island and route sizes. Raise a budget by the measured amount with its reason (`bun run budget-raises`); never cut a feature to hold one |

## 3. Carry the apps

| Path | What moves an existing app |
|---|---|
| `x upgrade` | the hop raises the app's Bun floor and rebaselines `unit` coverage on a Bun-floor hop ([CLI reference](../../wiki/CLI-Reference.md)) |
| the `runtime-pin` codemod (`packages/cli/src/codemods/runtime-pin.ts`) | moves an app's Dockerfile `FROM`, workflow `bun-version:`, `engines.bun` and `.bun-version` to the scaffold's; a pin the app chose itself is reported with its diff |
| `bun run scripts/template-codemods.ts` | refuses a scaffold template change with no codemod row |

## 4. Record and gate

| # | Step |
|---|---|
| 1 | `CHANGELOG.md` `[Unreleased]` on `next`: `- **BREAKING — (#N) Bun <new> is the floor.**` with what the patch moved and what this repository did about each |
| 2 | the matching row in `wiki/Upgrading.md`'s unreleased major section; `bun run changelog-check` |
| 3 | `bun run verify` — green is the verdict |
| 4 | `bun run scripts/reference-app-gate.ts` — the three tracked apps, built and gated on the new Bun |
