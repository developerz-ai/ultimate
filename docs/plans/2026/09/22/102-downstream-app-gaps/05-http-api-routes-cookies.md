# 05 — HTTP: declared `api/` handlers, raw bytes, HMAC verify, cookies

> Part of [`overview.md`](overview.md). Depends on: 01 (`serializeSetCookie`). Tier: 2.

Rule: an `api/**/route.ts` is a **route** whose handler reads the request itself. It exists only
for what an action structurally cannot do: raw bytes, inbound headers, a foreign protocol. It is
declared, and never silently ignored.

As of 2026-09-22 the tree reserves the file (`packages/render/src/registry.ts:33`, `CLAUDE.md:393`)
and documents a `POST` export (`packages/http/README.md:284-310`,
`docs/architecture/17-uploads.md:108-125`, `wiki/Known-Gaps.md:40`). `app-load.ts:166-170` imports
the module, registers its actions and queries, and drops the method exports. Every mount list
(`serve.ts:386-387`, `dev-route-table.ts:79`) holds only `apiRoutes()`, so the documented example
answers `X_ROUTE_NOT_FOUND`.

## Files to change
- `packages/http/src/api-route.ts` (new, < 200 LOC) — `defineApiRoute({ name, auth, policy?, rateLimit?, why, maxBodyBytes? })`.
  - `auth: 'public' | 'required'` is required, matching `RouteMeta.auth` (`router.ts:36-45`).
  - `why` must be non-blank, refused like `unenforced` (`packages/query/src/read.ts:216-226`). A blank `why` is `X_API_ROUTE_UNDECLARED`.
  - Returns a branded config.
  - `apiRouteHandlers(file, module)` reads the `GET`/`POST`/`PUT`/`PATCH`/`DELETE` exports and returns `Route[]` with `meta.enforcedBy: policy ? 'pipeline' : undefined`. The path comes from `routePathFromFile` (render owns it; slice 11 passes the path in, so http does not import render).
  - A module exporting a method with no `config`, or a `config` that is not `defineApiRoute`'s, is `X_API_ROUTE_UNDECLARED`. The fix line spells the three-line `export const config = defineApiRoute({...})`.
- `packages/http/src/request.ts:134-240` — refactor `#read()` so the capped read is cached as bytes once.
  - `bodyBytes(): Promise<Uint8Array>` returns the exact bytes.
  - `bodyText()` decodes them.
  - `bodyRaw()` parses from the same cache, so there is still one reader, one limit and one parse.
  - The handler gets `request.header(name)` (already `:99`) and `request.headers` (`:64`).
- `packages/http/src/webhook-verify.ts` — split into:
  - `verifyHmacSignature({ bytes, signature, secret, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64', prefix? })`, a constant-time compare through `timingSafeEqual`, raising `X_HMAC_SIGNATURE_INVALID`;
  - the existing `verifyWebhookSignature` (`:117-175`), now built on it for the framework's own scheme.

  Senders that sign a header over the raw body (payment gateways, most SaaS) call the first. Senders that sign *parsed fields* (for example a gateway's in-body `signature.checksum`) compute their canonical string in app code and call it with those bytes. The README shows both.
- `packages/http/src/cookies.ts` (new) — `setCookie(name, value, options)` and `clearCookie(name)`, which append `serializeSetCookie(...)` to the in-scope `RequestContext.headers` (`context.ts:66-67`). Usable from a route `load`, an action `handle` and an api handler, because each runs inside the request context.
- `packages/http/src/stages.ts:444` — **bug fix**: the merge `response.headers.set(name, value)` collapses every `set-cookie` but the last. Append `set-cookie` entries (`ctx.headers.getSetCookie()`) and keep `set` for the rest. Patch-worthy by itself.
- `packages/http/src/errors.ts` — `X_API_ROUTE_UNDECLARED`, `X_API_ROUTE_CONFLICT` (thrown by the mounter in slice 11, registered here), `X_HMAC_SIGNATURE_INVALID`.
- `packages/http/src/index.ts` — exports.
- `packages/http/README.md:284-310` — rewrite the webhook section around `defineApiRoute` and add a "When a route and not an action" table (bytes, headers, foreign protocol, streaming upload). Add a `setCookie` section.
- `packages/render/src/modes.ts:166-171` — `X_ROUTE_MODE_INVALID`'s fix for an `api/` file becomes "replace `defineRoute` with `defineApiRoute`, or with an action".

## Steps
1. Byte cache in `UltimateRequest`. The existing request tests must stay green: the multipart, form, `text/*` and JSON branches at `:190-240` all get their input from the one cache.
2. `defineApiRoute` and `apiRouteHandlers`, pure, with a table of fixture modules as tests.
3. `verifyHmacSignature`, then rebase `verifyWebhookSignature` onto it.
4. `setCookie` plus the `stages.ts:444` fix.

## Tests
- `bun test packages/http/src/request.test.ts packages/http/src/api-route.test.ts packages/http/src/webhook-verify.test.ts packages/http/src/cookies.test.ts packages/http/src/pipeline.test.ts`.
- `bodyBytes()` equals the sent bytes for a `text/plain` body with a trailing CRLF and invalid UTF-8.
- HMAC: a flipped byte is refused, and the compare is `timingSafeEqual` (spy).
- Two `setCookie` calls give two `set-cookie` headers on the final response. The test fails on today's `stages.ts:444`.
- A route module exporting `POST` with no config is `X_API_ROUTE_UNDECLARED`.
- CSRF: an anonymous `POST` to a `public` api route passes, and one with a session cookie from a cross-site origin is refused. That proves no opt-out is needed (`csrf.ts:37-39,59`).

## Done when
- `@ultimat3/http` exports `defineApiRoute`, `apiRouteHandlers`, `verifyHmacSignature`, `setCookie`, `clearCookie`, and `UltimateRequest#bodyBytes`.
- Mounting them is slice 11. This slice is green on its own tests plus `bun run typecheck`.
