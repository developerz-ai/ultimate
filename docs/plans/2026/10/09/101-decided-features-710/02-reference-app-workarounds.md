# 02 — The framework absorbs the reference app's workarounds (decision 19, rest)

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0, 3, 4.

## Files to change
- `packages/core/src/wire-dates.ts` (new) — `wireDatePaths(value)`: the paths of every `Date` in an answer, array indices folded to `*` unless a string shares the pattern; `reviveWireDates(value, header)`.
- `packages/core/src/client-dispatch.ts`, `client-transport.ts` — read `x-ultimate-dates`, revive `data` after the parse.
- `packages/query/src/record-answer.ts` — every read answer names its instants in the header.
- `packages/ui/src/` — `uiStrings(t, keys?)` (server: the `ui.*` subset an island reads) and `UiProvider`'s `strings` prop (client: the translator over them).
- `examples/dummy/apps/web/shared/{wire,ui-strings,ui-strings-server}.ts` — deleted; their callers use the framework.

## Steps
1. Failing tests first: a query answering a `Date` reaches `queryClient` as a `Date` (core + query); `UiProvider strings=` resolves a key and misses loudly.
2. Header only: the body and OpenAPI are unchanged; a client that ignores the header reads what it read before.
3. Measure the island/route budgets; raise by the measured bytes with the reason if needed.

## Done when
- No `wireDate`/`uiTranslator`/`uiStringsFor` in `examples/dummy`; the reference-app gate green.
