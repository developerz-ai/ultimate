# 16 — Migrate the reference app

> Part of [`overview.md`](overview.md). Depends on: 14. Tier: app (`examples/dummy`).

## Files to change
| File | From | To |
|---|---|---|
| `examples/dummy/apps/web/app/settings/settings.island.tsx:110-116` | 5 `createSignal` + raw `fetch` POST (to dodge `rpc`'s 14.8 kB) | the settings action's `.client()`; if the budget (20 kB) breaks, fix the transport's size, not the island |
| `examples/dummy/apps/web/site/pricing/contact-sales.island.tsx:52` | raw `fetch` | action `.client()`; `site/` may not import `app/` — import from `shared/` (axiom 6) |
| `examples/dummy/apps/web/app/feed/feed.island.tsx:88-95` | own `LiveClient` + `useLive` | `useQuery(feed, {})` rendered through a `@ultimat3/ui` list (slice 13) |
| `examples/dummy/apps/web/app/posts/[id]/like.island.tsx:110-116,172-182` | own `LiveClient` + `MemoryLocalStore` + `OfflineQueue` + `RebaseLog` + hand-mirrored `identity.subscribe`→`createSignal` | `useRecord(post, id)` + `useMutation(likePost)` (HTTP, slice 08); no local wiring |
| `examples/dummy/apps/web/shared/live-socket.ts`, `shared/sync-url.ts` | app-owned socket | delete |
| `examples/dummy/apps/web/app/posts/[id]/page.tsx:195` | `onClick={client.publishPost}` in a server page — inert | a `publish.island.tsx` using the action client (or a native `<form method="post">`) |
| `site/offline/page.tsx:52`, `app/update-banner.tsx:10` | `hasLiveClient()` | page-client check from slice 06 |

- New: a second island rendering the same post (e.g. like count in header + in body) to exercise "one record, many places".

## Steps
1. Migrate each island; keep `budget.js` values (feed 60 kB, post 56 kB, settings 20 kB).
2. Add the multi-place island.
3. `dummy/social-media-clone`: no islands — no change; confirm its `expectedRed` in `scripts/lib/gated-apps.ts` is untouched.

## Tests
- `examples/dummy/.../one-record-many-places.e2e.test.ts`: like in island A → count updates in island B from one frame; exactly one `/_x/sync` upgrade on the page.
- `two-tabs.e2e.test.ts`: two tabs, one `/_x/sync` upgrade; like in tab 1 shows in tab 2 (slice 11).
- `sign-out.e2e.test.ts`: sign out → no record of the previous principal visible, IndexedDB scope wiped (slices 03, 12).
- `offline-like.e2e.test.ts`: go offline, like, reload, still liked (IndexedDB), reconnect → server ack, no flicker.
- `island-bytes.test.ts` green.
- `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify`; `bun run scripts/reference-app-gate.ts`.

## Done when
- The dummy app has exactly one data path per concern: reads `useRecord`/`useLive`, writes action/mutator clients, realtime `useChannel`.
