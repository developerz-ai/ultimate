# 08 — Guards: the one path is a build error

> Part of [`overview.md`](overview.md). Depends on: 03, 04, 05, 07. Tier: scripts (gate `unit` step).

## Files to change
- `scripts/browser-transport.ts` (new) + `.test.ts` — model on `scripts/async-context-guard.ts` (seam constant, scans `packages/*/src` + `APP_ROOTS` = `{examples,dummy}` per `scripts/boundaries.ts:359`, skips tests). Reports, in browser-reachable source:

| Shape | Allowed only in |
|---|---|
| a `fetch(` **call** (a `fetchImpl = globalThis.fetch` default is the seam, never reported — `flight-copies.ts`'s split) | `packages/core/src/client-transport.ts` |
| `new WebSocket(` | `packages/realtime/src/browser-socket.ts` |
| `new XMLHttpRequest(` | `packages/storage/src/upload-client.ts` (progress) |
| `new EventSource(` | nowhere |
| any of the above | `packages/pwa/src/service-worker.ts`, `strategies.ts` (SW realm, no page store) |

  Browser-reachable = `*.island.tsx` and their import closure, plus framework `src/` not under a `server` export. Server-only fetches (`auth/oauth-*`, `mail/driver-resend.ts`, `jobs/webhook.ts`, `core/otlp.ts`, `cache/purge-http.ts`) are out of scope by that closure, not by pin. A local identifier named `fetch` (`action/src/idempotency-postgres.ts:210`) is not a call of the global — resolve by binding.
  Code `X_BROWSER_TRANSPORT_BYPASS`, fix line names the seam: `use <action>.client() / <query>.client() / useChannel()`. Pinned at **zero**, enforcing outright — slices 03/07/09 land the sweep first.
- `scripts/channel-literals.ts` (new) + `.test.ts` — refuses a string literal passed where a channel is expected / a topic built by concatenation outside `realtime/src/channel.ts`. Code `X_CHANNEL_LITERAL`. Zero.
- Gate wiring: the `unit` step list alongside `async-context-guard` (find where it is invoked from `packages/cli/src/verify-step.ts`); root `package.json` scripts `browser-transport`, `channel-literals`.
- `CLAUDE.md` Commands table: one row each, house style (why it exists, what it matched on, pinned at zero).
- `wiki/Error-Codes.md` rows; `bun run gate-codes` keeps the never-ships list honest; `bun run manifest`.
- App-side: `x verify` must run the same rule in a scaffolded app (the check reads app roots) — confirm `reference-app-gate.ts` sees it.

## Steps
1. Write rule + tests covering each false positive listed above (a noisy rule gets switched off).
2. Run against the tree after slices 03–07 + 09: must be zero.
3. Wire into gate, docs, manifest.

## Tests
- `bun test scripts/browser-transport.test.ts scripts/channel-literals.test.ts`: each shape reported outside its seam; default parameter not reported; SW files not reported; server-only closure not reported; a re-introduced `fetch` in `settings.island.tsx` reported.

## Done when
- `bun run browser-transport && bun run channel-literals` exit 0; reverting any slice-09 migration makes them exit 1.
