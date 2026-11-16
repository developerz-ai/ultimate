# Adopt a Solid major behind `next`

**A Solid major is a break for every app: it lands on `next`, rides the next major, and moves every
site in one diff.** `@ultimat3/ui`, `@ultimat3/admin` and `@ultimat3/testing` peer on `solid-js`,
and the scaffold pins the exact version this repository runs, so an app meets the new major the day
it installs the release.

**Rehearsal:** none yet; no stable Solid major exists to adopt. `As of 2026-11-15`
`npm view solid-js dist-tags --json` answers `latest` 1.9.19, `next` 2.0.0-rc.22, and
`npm view babel-preset-solid dist-tags --json` answers `latest` 1.9.19, `next` 2.0.0-rc.2. This
repository runs 1.9.18. Run the sequence first against the `next` tag on a throwaway branch to size
the work; adopt only a `latest`.

## 0. Preconditions

| Check | Command | Stop when |
|---|---|---|
| the lane exists | `git ls-remote origin next` | empty |
| a stable major | `npm view solid-js dist-tags --json` | `latest` is still the old major |
| the compiler matches | `npm view babel-preset-solid dist-tags --json` | no `latest` at the same major — every island is compiled by it |
| the migration notes | Solid's release notes for the major, read whole | — |

## 1. Move every site (one PR, to `next`)

| Site | Kind |
|---|---|
| root `package.json` `devDependencies.solid-js` | exact — what this repository builds and tests against |
| `packages/ui/package.json`, `packages/admin/package.json`, `packages/testing/package.json` | `peerDependencies.solid-js` range: the public promise to apps |
| `packages/cli/package.json` `dependencies.babel-preset-solid` | the island compiler (`packages/cli/src/solid-loader.ts`) |
| `packages/cli/src/templates/scaffold-repo.ts` `SOLID_VERSION` | what `x new` writes; `scaffold-repo.test.ts` holds it equal to the root pin |
| `packages/cli/src/doctor-advisory-floors.ts` `solid-js` floor | `SOLID_FLOOR`, what the `solid-floor` codemod raises an app to |
| `examples/dummy/package.json`, `examples/dummy/apps/web/package.json`, `examples/dummy/packages/ui/package.json`, `dummy/docs-site/package.json`, `dummy/social-media-clone/package.json` | exact pins in the tracked apps |

Then `bun install` and `bun run lockfile`.

## 2. Make it compile and pass

| # | Step | Reads |
|---|---|---|
| 1 | `bun run typecheck` | every `.tsx` against the new `solid-js` types |
| 2 | `bun test ./packages/ui/ ./packages/admin/ ./packages/testing/` | the components and the test renderer |
| 3 | `bun test ./packages/cli/src/island-solid-dedupe.test.ts ./packages/cli/src/templates/scaffold-repo.test.ts` | one Solid per island bundle; the scaffold pin |
| 4 | `bun run x -- verify --only e2e --json --cwd examples/dummy` | islands hydrating in a real browser |
| 5 | budgets: a runtime change moves island bytes. Raise by the measured amount with its reason (`bun run budget-raises`) | axiom 9 |

## 3. Carry the apps

| # | Step |
|---|---|
| 1 | Every scaffold-owned template that changed needs a codemod: `packages/cli/src/codemods/<id>.ts` plus its row in `scripts/template-codemods-rows.ts`; `bun run scripts/template-codemods.ts` refuses one without |
| 2 | An app's own `.tsx` is the app's: what the major changes in user code is a `wiki/Upgrading.md` entry with a before/after, never a silent rewrite |
| 3 | `bun run scripts/upgrade-fixtures.ts --verify --json` — past scaffolds hopped to this tree with zero hand edits |

## 4. Record and gate

| # | Step |
|---|---|
| 1 | `CHANGELOG.md` `[Unreleased]` on `next`: `- **BREAKING — (#N) solid-js <major> is the peer.**`, its `wiki/Upgrading.md` row; `bun run changelog-check` |
| 2 | `bun run verify` |
| 3 | `bun run scripts/reference-app-gate.ts` |
