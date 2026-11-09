# 14 — render: fast SSR for big pages, a bounded and shareable ISR store

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`render`). Render spans are [`20`](20-observability.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| P1 | **High** | `render/src/render-html.ts:107-125` | one `async` + `Promise.all` per node: 10k rows 189 ms / 27 MiB heap; 50k rows 1,054 ms / 98 MiB; a template-string baseline does 50k in 15 ms (~70×) | sync fast path: `unwrapSync` returns a string until it meets a Promise, hole or island, then hands off to the async walker; arrays join a `string[]` |
| P2 | Med | `render/src/render-isr-store.ts:80-110` | caps entry count (1,000), not bytes (1,000 × 7 MiB = 7 GiB); evicts by generation order, so a hot early page is evicted before cold later ones | `maxBytes` (default 256 MiB, counts `html.length`); true LRU on `get`; `markStale` keeps position |
| P3 | Med (scale) | `render/src/render-isr-store.ts:54` | `IsrStore` has only a memory implementation: 3 web replicas = 3 ISR caches, 3 regenerations | `storageIsrStore(disk)` over `@ultimat3/storage` (tier 1, legal) with a generation fence; wired through [`21`](21-adapter-wiring.md) |
| P4 | Low (adopter-found) | `render/src/client.ts:14`; `render/src/navigation-api.ts` → `navigation-errors` | `NAVIGATION_MODAL_ATTRIBUTE` not exported browser-side (an adopter restates `dialog[data-x-modal]`); `navigate()` pulls core's error registry (8,959 B measured by the adopter) into islands that import nothing of core | export the constant from `client.ts`; `navigation-errors` imports from `@ultimat3/core/client` ([`02`](02-core-schema.md) K6) |
| P5 | Low | `render/src/navigation.ts` (500 lines) | at the ceiling; three jobs (interception, swap, history) | split by responsibility |
| P6 | Low (verify) | islands (`render/src/hydrate.ts`) | SSR and `ui` Link block `javascript:`; a raw `<a href={row.url}>` inside an island goes through Solid's setter. CSP blocks it today; a looser app CSP would not | a dev-mode check in the island attribute path warning on a non-`safeUrl` href, or document; write the failing test first |

## Files to change
- `packages/render/src/render-html.ts`, `render-isr-store.ts`, `render-isr-store-storage.ts` (new), `client.ts`, `navigation-api.ts`, `navigation-errors.ts`, `navigation.ts` → `navigation-*.ts`, `index.ts`.
- `scripts/bench/render-html.bench.ts` (new) + `scripts/bench/results/` entry + the `bench-claims.ts` row.
- `packages/render/README.md`.

## Tests
- `render-html.bench.test.ts`: 10k-row table < 40 ms (CI ceiling with slack); all existing render tests green.
- `render-isr-store.test.ts`: byte-cap eviction; a read page stays, an unread goes.
- `render-isr-store-storage.test.ts`: two stores over one memory disk share an entry; generation fence refuses a stale write.
- Bundle pin: an island importing `navigate` contains no core error titles.
- `bun test packages/render`

## Done when
- The 50k-row page renders in < 100 ms and < 30 MiB heap.
