# 28 — Public text responses are gzipped

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`http`), 5 (`cli`).

## Why
No response is ever compressed: no `content-encoding` anywhere in `packages/http/src` or `packages/cli/src`, and no doc tells an operator to add it. The compose file ships with no proxy (`docs/idea/12-build-deploy.md:90`). Axiom 7 rules out assuming an edge.

Probe, 2026-11-02: real `httpPipeline` on `Bun.serve`, immutable `text/css` route, `accept-encoding: gzip, br`: `200 content-encoding null`, wire 95,000 B of 95,000 B.

| Reference app export | Raw | gzip L6 | brotli q5 |
|---|---|---|---|
| `/` document's stylesheet (document is 3,935 B) | 103,957 | 15,574 | 14,569 |
| every `.css`, `.js`, `.html` in the export | 712,353 | 193,291 | 183,536 |

Adopters: two hand-rolled it (one gzip + brotli route for a large API document, in a 151-line file, one reverse-proxy config). The three adopters on the framework carry no proxy in their repositories and no compression. Evidence limit: a CDN in front of them would not show there.

Brotli saves 5% over gzip here and needs `node:zlib`; `Bun.gzipSync` needs nothing. One coding. Cost: 1.4–2.9 ms per gzip of the largest stylesheet, 0.008 ms to hash it, so no memo in this slice: a second cache needs a measurement that asks for it.

A pipeline stage must not buffer what it cannot bound. Probe: `new Response(string)`, bytes, a `Blob` and a stream all answer `content-length` null, and only `/_storage` and downloads set it today. So the length is declared by the sites below, and a body without one passes untouched.

## Files to change
- `packages/http/src/compress.ts` (new) — `compressResponse(request, response)`: the one rule below.
- `packages/http/src/pipeline.ts:94` — new `compress` row after `response`, last, with its `why`.
- `packages/http/src/stages.ts:430` — `compress` entry in the `Record<StageName, StageRun>`; replaces `ctx.response`.
- `packages/http/src/response.ts:17,23,29` — `jsonResponse`, `textResponse`, `html` set `content-length` from the string's byte length, unless `init` set one. `stream` (`:39`) never does.
- `packages/cli/src/style-routes.ts:52`, `island-routes.ts:54`, `worker-bundle.ts:227`, `sw-routes.ts:27`, `site-asset-routes.ts:38` — the same, from the bytes they hold.
- `etagMatches` (`packages/cli/src/runtime-storage.ts:185`, in `http` once [`28-assets-stored-objects.md`](28-assets-stored-objects.md) lands): no change, it already strips `W/`; a test pins it for the weakened tag.
- `docs/architecture/03-request-lifecycle.md:7` — "Fourteen" becomes fifteen, with the row.
- `docs/architecture/16-build-pipeline.md` — section: what is compressed and what is not.
- `wiki/Deployment.md` — one row: the container compresses; a proxy in front changes nothing, since a coded response is not re-coded. A private answer stays identity.

## Steps
1. `compressResponse` passes through untouched unless all hold:
   | Condition | Why |
   |---|---|
   | method `GET`, status `200` | no 206, 304, or HEAD body |
   | `accept-encoding` lists `gzip` with q above 0 | RFC 9110 |
   | no `content-encoding`, no `content-range` | a handler's own coding stands |
   | `cache-control` has no `private`, `no-store` or `no-transform` | **BREACH**: a private document reflects a CSRF token beside attacker input. Public bytes hold no secret. `stream` mode is always `private, no-store`, so it never buffers |
   | essence of `content-type` in the allowlist | `text/html`, `text/css`, `text/javascript`, `application/javascript`, `application/json`, `application/manifest+json`, `image/svg+xml`, `application/xml`, `text/xml`, `application/rss+xml`, `application/atom+xml`, `text/vtt`. Never `text/event-stream`; images and fonts are already coded |
   | `content-length` declared, from `COMPRESS_MIN_BYTES` (1,024) to `COMPRESS_MAX_BYTES` (1 MiB) | below, the header overhead wins. Above, `gzipSync` blocks the loop past about 30 ms, extrapolated from the measure above and not run. Undeclared means unknown: never read. A chunked `stream()` declares nothing |
2. Coded answer: new `Response` over `Bun.gzipSync(bytes, { level: 6 })` with the same status and headers, `content-encoding: gzip`, `content-length` set, `accept-ranges` removed, strong `etag` weakened to `W/`.
3. `addVary(response, ['accept-encoding'])` (`response.ts:189`) on every response that passed the type and cache conditions, coded or not, so a shared cache cannot hand a coded body to a client that refused it.
4. The body is read only after every condition holds, so a passed-through response is never touched. A stream that declares a length in range is read counted: past its declared length, the bytes read and the rest go out as identity, `http.compress_failed` logged. The buffer never passes `COMPRESS_MAX_BYTES`.
5. A `Bun.gzipSync` throw returns the identity response and logs `http.compress_failed`. Never fails a request.
6. A handler streaming public text it must not buffer sets `no-transform`. Documented in `wiki/Deployment.md`.

No option. There is no reason to turn it off that `no-transform` does not cover. `budget.js` is unchanged: it bounds parse cost, not transfer (`wiki/Routes-And-Render-Modes.md:300`).

## Error codes
None. A compression failure is not a request failure; the identity answer stands and the log line carries it.

## Tests
- `packages/http/src/compress.test.ts`, unit, one case per row of the table, each asserting the other side too: `private` stays identity with a body that would otherwise compress; a `Range` answer stays 206; `no-transform` stays identity; q=0 stays identity; no `content-length` stays identity and the body is not read (a stream that fails if pulled); 1 MiB + 1 stays identity; a stream longer than it declared arrives whole; decoded bytes equal the source; `vary` present on both.
- `packages/http/src/response.test.ts`: `html` with a multi-byte body declares its bytes, not its characters.
- `packages/http/src/stages-csp.test.ts` neighbour: a security header set by `response` survives the rebuild.
- `packages/http/e2e/` socket test: `Bun.serve` + pipeline, raw `fetch` with `decompress: false`; fails today with the probe's output.
- `packages/cli/src/static-document.test.ts`: `If-None-Match: W/"<hash>"` answers 304.
- `bun test packages/http/src/compress.test.ts`

## Semver
**Breaking, one row.** `PIPELINE_STAGES` is an exported constant and gains a stage; `StageName` widens, so a `Record<StageName, …>` stops compiling.
Upgrading: "Add `compress` to any `Record<StageName, …>`. A public text answer between 1 KiB and 1 MiB with a declared length gains `content-encoding: gzip` and a weak `etag`; a handler that must not be coded sets `no-transform`. `html`, `textResponse` and `jsonResponse` now set `content-length`: a handler that rewrites such a body drops the header."

## Done when
- The reference app's `/` stylesheet leaves the container at 15,574 B against `accept-encoding: gzip`, and 103,957 B without.
- A signed-in document is identity on the wire; a public stream with no declared length is identity and unbuffered.
- `PIPELINE_STAGES` shows `compress` on `/_x`.
