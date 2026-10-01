# 07 — CLI: the browser-transport rule in every app's gate

> Part of [`overview.md`](overview.md). Depends on: 03. Tier: 5.

Rule: a raw `fetch(`, `new WebSocket(` or `XMLHttpRequest` in browser-reachable app code is
`X_BROWSER_TRANSPORT_BYPASS` on `x verify`'s `boundaries` step — in every app, not only in this
repository.

Evidence: the check is `scripts/browser-transport.ts`, run by this repo's `unit` step;
`wiki/Client-Data.md:33-35` says it is "not yet a step of `x verify`". The downstream app has 41
raw `fetch(` in non-test source, 16 inside islands, across four request styles.

## Files to change
- `scripts/lib/transport-calls.ts`, `scripts/lib/import-closure.ts`, `scripts/lib/server-barrels.ts`
  — move into `packages/cli/src/`. A script cannot be imported by a published package.
- `scripts/browser-transport.ts` — becomes a thin caller of the CLI's function. One implementation.
- `packages/cli/src/app-boundaries.ts:257` (`checkAppBoundaries`) — add the transport check to the
  findings it returns. Built in, not a `guards/` file: an app must not be able to delete it.
- `packages/cli/src/verify-checks.ts` `boundaries` summary line — name the rule.
- `wiki/Client-Data.md:33-35` — the sentence becomes true.

## Steps
1. Settle the semver question in `overview.md` *Risks* first. It decides which release this rides.
2. Move the three library files with `git mv`; keep their tests beside them. `scripts/` imports
   them back from `@ultimat3/cli`'s internal path the way other scripts already reach CLI modules.
3. App roots: the script reads `APP_ROOTS` from `scripts/boundaries.ts`; the CLI version takes the
   app root `x verify` already has.
4. Seams stay the three in `TRANSPORT_SEAMS` (`scripts/browser-transport.ts:37-41`). In an app
   they resolve inside `node_modules/@ultimat3/*`; the closure walk must stop at the package
   boundary and trust the framework's own seam files.
5. Keep the stated blind spots (`scripts/browser-transport.ts:18-20`) in the finding's docs, not
   in silence.
6. The fix text names the replacement: `clientTransport` for a one-off, `rpc<Api['actions']>` for
   an action, `useQuery` for a read, `@ultimat3/storage`'s upload client for a file.
7. A presigned upload is the one legitimate raw request in the evidence; it is already covered by
   `packages/storage/src/upload-client.ts:67`. No allowlist.

## Tests
- `packages/cli/src/browser-transport.test.ts`: an island with `fetch(` is a finding; the same
  call in a `route.ts` is not; a server barrel in an island closure is `X_BROWSER_SERVER_BARREL`.
- `scripts/browser-transport.test.ts:263` keeps passing over both tracked apps.
- Command: `bun test packages/cli/src/browser-transport.test.ts`.

## Done when
- In a scaffolded app outside this checkout, `fetch('/api/x')` in an island turns `x verify` red.
- `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green.
