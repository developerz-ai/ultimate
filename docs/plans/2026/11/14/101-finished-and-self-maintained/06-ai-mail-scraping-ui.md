# 06 — ai, mail, scraping, ui, notify, pwa

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-jobs-realtime.md). Tier: 4.

## Files to change
- `packages/ai/src/gateway.ts:270` — A1. Fallback across providers belongs to `generate` alone; no cross-model fallback, provider parameters not passed through. Two adopters wrote their own routing (4,533 and ~1,950 LOC).
- `packages/ai/src/` prompt cache — A2. No rule for a custom host.
- `packages/mail/src/` — M1. Delivery events only (`*-event-receiver.ts`); no inbound. The one mail-using app parses inbound itself.
- `packages/scraping/src/cdp-target.ts:200-430` (11), `html-target.ts:370,393` — S1. `NotImplementedError` on the port.
- `packages/ui/src/` — U1. a11y roles deferred (2026/11/11 slice 15 T3); touch-drag proofs (2026/11/02 slice 38).
- `packages/admin/src/` — U2. `search_tsv` (2026/11/11 slice 15 D1).
- `packages/notify/src/`, `packages/pwa/src/`, `packages/flags/src/` — N1. Imported by 0, 0 and 0 of 10 apps.

## Steps
1. A1: `fallbackModels` on the model reference — an ordered list tried on a declared error class, billed per attempt, one trace. Provider parameters pass through a typed `providerOptions` bag validated per provider. Follow `packages/ai/src/llm.ts`; no second gateway.
2. A2: `registerPromptCacheRule(host, rule)`.
3. Media generation stays deferred: still one app ([`90`](90-owner-decisions.md) OD7).
4. M1: `inboundMail()` — a factory over the webhook-receiver action: provider signature check, parse to a typed message, attachments to `storage` through the upload path. Parsing is in-tree, no new dependency unless `docs/idea/18-build-vs-wrap.md`'s bar is met and stated in the PR.
5. S1: for each stub, implement it on the CDP target or remove the method from the port for every target. A port method one target cannot honour is a second path. Three apps add a browser dependency beside `scraping`; record in `wiki/` which of their uses the port now covers.
6. U1: the deferred roles; touch-drag proven with real pointer events in the CDP page ([`07`](07-gate-truth.md) gives the browser). U2: `search_tsv`.
7. N1: the reference app exercises each package through a real path that `exercise` and `e2e` reach (a flag gating a route, a notification delivered to a fake push endpoint, an offline navigation served by the worker). Unused-by-apps stays true until [`13`](13-shapes-and-declaration.md)'s shapes; unproven must not.

## Tests
- `bun test ./packages/ai/src/gateway.test.ts -t 'fallback'` — second model answers after the first's declared failure; cost meter counts both.
- `bun test ./packages/mail/src/inbound.test.ts` — forged signature refused; a multipart message round-trips.
- `bun test ./packages/scraping/src/port-complete.test.ts` — every port method callable on every target.
- `bun run x -- verify --only e2e,exercise --cwd examples/dummy`.

## Done when
- `grep -rn NotImplementedError packages/scraping/src --include='*.ts' | grep -v test` is empty.
- The two adopters' routing layers have a mapped replacement ([`46`](46-adopter-g.md), [`47`](47-adopter-h.md)).
