# 39 — Public `renderNodes`, from a tier that can be imported

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`, subpath), 4 (`render`, `ui` tests), 5 (`admin` tests).

## Why
A markup string cannot answer "does this element carry `aria-live`, and does its `onKeyDown` move focus". Two private walkers answer it: `ui/src/jsx-probe-fixture.ts` (35 test files import it) and `admin/src/inert-jsx-fixture.ts` (8), near-identical and unshipped (`!src/**/*-fixture.ts`). So two adopters made 43 test moves copying a helper any app with components needs.
Recorded objection: `ui → testing` fails `boundaries`, and the same for `admin → testing` (sideways). Answer: the walker needs nothing from `testing` or `render`. It reads one global symbol and a `type`/`props` shape, so it belongs at the bottom.

## Decisions
| Question | Answer |
|---|---|
| Legal home | `@ultimat3/core/render-nodes`, and the leaf `@ultimat3/core/render-node`: subpaths, as `./page` is (`core/package.json:22`). `core` is the one tier both `ui` and `admin` and every app reach; legal by the table, no new edge, no `FLOOR_ABOVE` row |
| Bundle cost | none: both off the barrel. `render-nodes` is imported by no non-test source, by a pinned test. `render-node` holds one `Symbol.for`, and `render` imports it. Axiom 6 unharmed |
| The symbol | `JSX_NODE` (`render/src/jsx.ts:8`) moves to `core/src/render-node.ts`, published at the leaf subpath: the barrel must not hold it, and `render` importing from `render-nodes` would break that file's own test. `render` imports the leaf, the "both tier 4, so the one literal lives here" pattern of `theme-storage.ts`. Three private copies of `Symbol.for('ultimate.render.jsx')` go |
| Second way beside `renderView`? | no; a different question. `renderView` answers what a reader sees, as markup and text. `renderNodes` answers what an element carries: handlers, refs, props no string can hold. `wiki/Testing.md` states the split in one row |
| `testing` re-export | none. "Imported from the package that declares it"; a test of an app imports the subpath directly |
| Differences between the copies | ui drops component nodes, admin keeps them. One walker: `nodesOf(value, { components?: 'expand' \| 'keep' \| 'stop' })`; `renderNodes` default `'expand'` is ui's, admin's two call the others |
| What stays private | admin's `h()` and `renderHtml`: a hand-built tree and a test-only serialiser. The fixture shrinks to them, over the public walker |
| Bare `Error` | the copies throw it (`jsx-probe-fixture.ts:64,74,81`); `source-bare-error-exemptions.ts` lists them. Public code uses core's `assert` (`X_INVARIANT`) and leaves that list |

## Files to change
- `packages/core/src/render-node.ts` (new) — `JSX_NODE`.
- `packages/core/src/render-nodes.ts` (new) — `isRenderNode`, `nodesOf`, `renderNodes`, `byTag`, `byComponent`, `withAttr`, `one`, `attachRef`, `fire`. Imports `render-node.ts` and `assert` only.
- `packages/core/package.json:20` — `./render-nodes`, `./render-node`; `packages/core/src/render-nodes-subpath.test.ts` (new) — both off the barrel; `render-nodes` imported by no non-test source; `render-node` imports nothing.
- `packages/render/src/jsx.ts:8` — import the symbol from `@ultimat3/core/render-node`.
- `packages/ui/src/jsx-probe-fixture.ts` — deleted; 35 test files plus `theme/inert-render.test.ts` import the subpath.
- `packages/admin/src/inert-jsx-fixture.ts` — keeps `h`, `renderHtml`, `renderComponent`; re-reads the walker; 8 tests, `inert-jsx.test.ts`.
- `scripts/lib/source-bare-error-exemptions.ts` — rows go. `packages/ui/package.json`, `packages/admin/package.json` — `@ultimat3/core` already declared.
- `wiki/Testing.md`, `packages/core/README.md`, `packages/core/CLAUDE.md` (the "ONE subpath" row: now three), `packages/ui/CLAUDE.md`, `packages/admin/CLAUDE.md`. `examples/dummy/apps/web/app/settings`: one test, since that app is what an author copies.

## Steps
1. New files and the subpath, with `render-nodes.test.ts` written from `inert-jsx.test.ts`'s premise cases.
2. `render` imports the symbol; `render/src/jsx.test.ts` still pins `Symbol.for('ultimate.render.jsx')`.
3. Mechanical import rewrite in `ui`, one commit. `attachRef`, `fire` signatures unchanged.
4. Admin, one commit. `byComponent` reads `type.name`, moved as written.
5. `bun run boundaries`, then both packages' suites unchanged in assertion count.

## Error codes
None new. `X_INVARIANT` from `assert` for `one()`, `attachRef`, `fire`.

## Tests
- `packages/core/src/render-nodes.test.ts` (unit): each of the three `components` modes on a tree with a component, a thunk and hand-built `{ inert: true }`; `one()` refuses zero and two, naming what it sought; an unknown object falls through to nothing, never `[object Object]`.
- `packages/core/src/render-nodes-subpath.test.ts`: barrel holds none of these names; `render/src/jsx.ts` resolves `JSX_NODE` through the leaf; `page-bundle.test.ts` unchanged.
- `packages/ui`, `packages/admin` suites: same pass count before and after. `bun test packages/core/src/render-nodes.test.ts`

## Semver
Minor. New subpath. `JSX_NODE`'s `render` export stays, the same symbol; the fixtures were never shipped.

## Done when
- `grep -rn "ultimate.render.jsx" packages --include=*.ts --include=*.tsx` answers `core/src/render-node.ts` and pinning tests only.
- `packages/ui/src/jsx-probe-fixture.ts` is gone and `bun run boundaries` green.
- An app test can import `renderNodes` with no dependency it lacks: `examples/dummy` does.
- `bun run verify` green.
