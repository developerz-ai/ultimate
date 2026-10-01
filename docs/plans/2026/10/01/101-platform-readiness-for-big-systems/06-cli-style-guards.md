# 06 — CLI: stylesheet rules as shipped guards

> Part of [`overview.md`](overview.md). Depends on: 05. Tier: 5.

Rule: off-ladder values and unstyled classes are build errors in a scaffolded app. Today only raw
colour is (`packages/cli/src/templates/guard-raw-colour.ts`), and Biome ignores stylesheets
(`packages/cli/src/verify-checks.ts:76-80`).

Evidence: the surveyed SPA holds these rules with hand-written scripts at a zero budget and still
carries 870 off-grid spacing literals from before the rule existed. The downstream Ultimate app
wrote `raw-shadow-motion` and `state-colour` guards of its own.

## Files to change
- `packages/cli/src/templates/` — one module per guard, the shape of `guard-raw-colour.ts`:

| Guard file | Refuses | Fix it names |
|---|---|---|
| `raw-length` | a `px` value outside `1px` hairlines, in `.scss` and in a TSX `style` | `rem()` or `space()` |
| `raw-breakpoint` | a hand-written `@media (min-width` / `(max-width` | `respond-to` / `respond-down` / `respond-between` |
| `raw-z-index` | a numeric `z-index` | `z()` |
| `raw-shadow` | a `box-shadow` literal | `shadow()` or `surface()` |
| `raw-motion` | a duration or `cubic-bezier` literal | `duration()` / `easing()` |
| `undefined-style-class` | `styles.<name>` where the imported `.module.scss` compiles no such class | add the rule or fix the name |
| `undeclared-custom-property` | `var(--x)` no global sheet emits | declare it through `defineTheme()` |

- `packages/cli/src/templates/scaffold-guards.ts:31-41` — add the seven.
- `packages/cli/src/generate-files.ts:146` (`case 'guard'`) — `x g guard <name>` writes the shipped
  guard when `<name>` is one of them, the blank template otherwise.
- `packages/cli/src/` doctor — list shipped guards the app lacks, each with its `x g guard` line.
- `examples/dummy/guards/`, `dummy/social-media-clone/guards/` — the demo has no `guards/`
  directory at all; both apps carry the full set after this slice.

## Steps
1. Read `guard-raw-colour.ts` and its test. Every new guard follows it: a `Guard`
   (`packages/cli/src/guards.ts:22-32`), findings with file, line and fix, a test beside it.
2. The two compiled-sheet guards reuse the module compiler (`packages/render/src/css-modules.ts:30-43`)
   through the CLI's existing seam. `cli → render` goes down.
3. `undefined-style-class` handles `styles['a-b']`, `classList={{ [styles.x]: … }}` and
   `:global()`. A computed member (`styles[name]`) is out of scope: state it in the guard header.
4. Run all seven over both tracked apps. Fix findings in the apps; do not add an allowlist.
   A finding in `@ultimat3/ui`'s own sheets is fixed in `packages/ui`.
5. Codes are the app's, derived from the filename (`X_RAW_LENGTH`, …): no registry entry.
6. `bun run scripts/guards-doc.ts --write`.

## Tests
- One `<guard>.test.ts` per template, each with a fixture that fails and one that passes.
- `packages/cli/src/templates/scaffold-guards.test.ts`: the scaffold writes all sixteen.
- Command: `bun test packages/cli/src/templates/`.

## Done when
- In a fresh `x new` app, adding `padding: 12px` to a module makes `x verify` red on `boundaries`
  with `X_RAW_LENGTH`, the line, and `fix: padding: space(3)`.
- Both tracked apps green under all seven; `scaffold-smoke` green.
