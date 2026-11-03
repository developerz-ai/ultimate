# 35 — An `isr` route keys on no query unless it says so

> Part of [`overview.md`](overview.md). Depends on: [`35-fix-security.md`](35-fix-security.md) (S2 edits the same file and moves every key once). Tier: 4 (`render`).

## Why
Undeclared `revalidate.query` keys on the whole query (`packages/render/src/render-isr-key.ts:22`), so any visitor can force a render and push real pages out of the bounded store, and `utm_*` splits one page per campaign. The file's own comment states this. `wiki/Known-Gaps.md:36,130` promised the flip "in the next major", and two majors have passed. Keep the promise: a shared artifact varies only on what the route declares.

## Files to change
- `packages/render/src/render-isr-key.ts:35` — the `query === null` branch of `isrRequestUrl` drops the query. Comment at `:22` restated.
- `wiki/Known-Gaps.md:36,130` — rows out. `wiki/Routes-And-Render-Modes.md`, `packages/render/README.md`, `wiki/Upgrading.md`.
- `examples/dummy` — any `isr` route that reads a query parameter declares it. Check with the app gate.

## Steps
1. Flip the branch.
2. A route whose `load` reads an undeclared parameter now serves one document for every value. Nothing can see that at build time from the key alone, so state it in the Upgrading row and name `revalidate.query`.

## Error codes
None.

## Tests
- `packages/render/src/render-isr-key.test.ts`: `/blog?x=1` and `/blog?x=2` share a key with no declaration; a declared `x` still splits; locale still splits. Fails today.
- `bun test packages/render/src/render-isr-key.test.ts`

## Semver
Breaking. Upgrading: "An `isr` route with no `revalidate.query` now keys on none of its query: declare the parameters it reads."

## Done when
- A flood of unique query strings on an undeclared `isr` route causes one render and one stored entry.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
