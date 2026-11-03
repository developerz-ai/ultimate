# 35 — Security fixes: one visitor's answer served to another, unchecked bytes

> Part of [`overview.md`](overview.md). Depends on: [`28-assets-stored-objects.md`](28-assets-stored-objects.md), which lands first (S4). S2 lands before the `isr` key flip in [`35-fix-isr-default.md`](35-fix-isr-default.md). S2 and S1 touch the same function, one agent. Tier: 0 (`core`), 1 (`storage`), 2 (`http`), 3 (`realtime`), 4 (`render`), 5 (`cli`).

## Why
Each row reproduced 2026-11-02 by a throwaway probe over the real modules. S1 is the serious one: an anonymous request received a signed-in visitor's row, with public cache headers.
S1 is a live hole and breaking: it ships in v30, beside [`01`](01-ai-tool-gate.md), per [`42-adopt-stability.md`](42-adopt-stability.md).

## Fixes
| # | Sev | Site | Failure, as printed | Smallest fix | Failing-first test |
|---|---|---|---|---|---|
| S1 | High | `cli/src/runtime-isr-outcome.ts:126`, `cli/src/runtime-render.ts:473`; `render/src/modes.ts:121` refuses only a declared `policy` | `isr` and `static` with an ungated `load` reading the actor. Alice, then anonymous: `row=SECRET-of-alice`, `public, max-age=0, s-maxage=300` on `isr`, `public, max-age=0, must-revalidate` on `static` (with `memoStatic`) | producer and static render run as anonymous through `withAnonymousRequest`, steps below | `cli/src/runtime-render-shared-actor.test.ts`: both modes, then anonymous, body holds no actor value; `setRedirect` in `load` still answers its `Location` |
| S2 | Med-high | `render/src/render-isr-key.ts:83` no origin; `cli/src/runtime-isr-outcome.ts:114` `data.url` keeps the request's; `cli/src/runtime-render.ts:130` | no declared origin: first request with a foreign `Host` stored; a later visitor's canonical and `og:url` name that host. Declared origin: canonical right, `data.url` still the request's | declared: `data.url` rewritten to the declared origin before the key. None declared: `isrKey(url, locale, origin?)` adds a reserved `__x_origin` param, as `cli/src/static-document.ts:93` keys. A param, not a prefix: `routePathOf` already drops the query. Added in `isrKey`, after `isrRequestUrl` narrows, so no `revalidate.query` and no later default can drop it | `cli/src/runtime-render-isr-keyed.test.ts`: two hosts, no declared origin, each sees its own canonical; declared origin, `load` sees the declared origin |
| S4 | High | `storage/src/driver-s3.ts:442`; false claims `storage/src/grant.ts:60-62`, `driver-s3.ts:425`, `storage/README.md:316`; `storage/src/attachment.ts:179` checks size alone | presigned PUT with `contentType: image/png` prints `X-Amz-SignedHeaders=host&response-content-type=image%2Fpng`: the header is unsigned, and that parameter governs a GET. An uploader stores any type and any bytes, and promotion only reads `size` | `promoteAttachment`, after the size check: sniff a head window with a ranged read, table below. All three claims corrected: the provider signature binds method and expiry only. A `target` grant has no promotion step, so it gets a row in `wiki/Known-Gaps.md`; `objectResponse` ([`28`](28-assets-stored-objects.md)) sandboxes it when served | `storage/src/attachment.test.ts`: HTML bytes under a pending key stating `image/png` refuse `X_STORAGE_TYPE_REJECTED`, key stays pending; a valid PNG twice the disk's `maxGetBytes` promotes, and a counting disk sees one read of at most 64 KiB; XML over the window refuses; `storage/src/driver-s3.test.ts` pins that a presigned PUT signs `host` alone, so the docs cannot drift back |
| S5 | Low-med | `realtime/src/sync-origin.ts:35`, `core/src/same-origin.ts:33` | list declared, `origin` unlisted: refused without `sec-fetch-site`, `{ ok: true }` with `sec-fetch-site: same-origin`. A browser sends that only for a page truly served from the host it dialled, so the reach is a sibling host pointed at the node, the case `selfOrigins: []` exists to close, with a `Domain=` cookie riding | `secFetchSite: null` when `admitted.length > 0 && !admitReached` | `realtime/src/sync-origin.test.ts`: listed origin passes, unlisted with that header refused, `x dev`'s `admitReached` unchanged |
| S6 | Low | `render/src/head.ts:120-124` | `renderHead` prints `onload="…"` and a `javascript:` `href`; `attributePair` answers `null` for both. Reached when an app spreads a row into `attrs` | `.map` through `attributePair`, `.filter(Boolean)`, one space join. `isAttributeName` filter goes: it is inside | `render/src/head.test.ts`: both absent; `content`, `rel`, boolean `async` unchanged. `bun run budget-raises` if a route moves |
| S7 | Med | `storage/src/upload.ts:142` | `slice(0, 512).trimStart()`: 512 whitespace bytes before markup answers `text/plain`. `validateUpload` then ACCEPTS it declared `application/xml`, `text/xml`, `text/plain`; without padding, `X_STORAGE_TYPE_REJECTED`. HTML and SVG bodies pass the sniff the same way | `text.trimStart().slice(0, 512)`; more than `MAX_LEADING_WHITESPACE` refused, table below | `storage/src/upload.test.ts`: padded XHTML, HTML, SVG each sniff as without padding; padded XML declared `application/xml` refused; 4,097 whitespace bytes refused on both paths; a multi-byte character cut at the window's end stays text |
| S8 | Low | `core/src/address-class.ts:104` | `2002:7f00:1::` and `2002:a9fe:a9fe::` class `public`; `64:ff9b::7f00:1` class `loopback`. Needs a route to a 6to4 relay, so low | in the embedded-IPv4 branch, `2002::/16` classifies bytes 2–5. Teredo `2001::/32` classes `private`, not unwrapped: its address obfuscates the client | `core/src/address-class.test.ts`: those two, `2002:0808:0808::1` stays `public`. Reaches `jobs/src/webhook-target.ts:77` and `screenDial` |

## Dropped here
| Finding | Reason |
|---|---|
| S3 `/media` `public, immutable` | [`28-assets-stored-objects.md`](28-assets-stored-objects.md) deletes `IMMUTABLE_IMAGE`, with the pin |
| S9 MCP version header and origin | [`27-mcp-dual-era.md`](27-mcp-dual-era.md): both probes in its *Why* and *Done when* |
| TOTP replay | [`25-pkg-auth-totp-replay.md`](25-pkg-auth-totp-replay.md) |

## Weighed, deferred (read only, no probe)
Not in [`90-deferred.md`](90-deferred.md) yet: coordinator's file.
| Candidate | Why not now | Comes back when |
|---|---|---|
| Host allow-list when `APP_URL` declared | S2 closes the one measured sink; a refusal is a second origin rule beside `proveSameOrigin` | a second sink reads the request's host |
| `query/src/download.ts:223` no policy at serve | deliberate; written reason there, and `admit` logs the skip. Token expiry is the bound | an adopter needs revocation inside a token's life |
| `admin/src/batch-job.ts:90` actor from queued payload | real, bounded by queue age; permissions are app state, and no seam reads them back | an app-supplied `actorFor(id)` seam exists for another reason |
| `core/src/seal.ts:71` AAD has no row id | needs write access to the column; AAD per row breaks deterministic lookup | an adopter's threat model says so |
| `issueVerification` per-address throttle | not reproduced; action `rateLimit` is the mechanism | a measured mail flood |

## S1, steps
1. **Not** the bare `withChildContext({ actor })` the finding proposed. Probed: `setRedirect` inside it answered `200`, no `Location`. `core/src/context.ts:298` builds a plain `ctxOf`, so `ctx.redirect` and the other request fields are not there.
2. `http/src/context.ts` — `withAnonymousRequest(ctx, fn)`: inside `withChildContext({ actor: anonymousActor() })`, so managed services rebuild for the anonymous actor, `runWithContext` over `{ ...ctx, ...child }` with `cookie` and `authorization` removed from the inbound headers. `fn` gets that scope. A spread of `ctx` alone keeps services built for Alice: the same leak by another door.
3. `runtime-isr-outcome.ts:125` — producer body inside it; `takeRedirect(scope)` rather than the outer `ctx`.
4. `runtime-render.ts:462` — `static` branch inside it, `load` and `document` both.
5. `render/src/modes.ts:115` comment states the rule. `wiki/Routes-And-Render-Modes.md:137,215`: a shared document is rendered as nobody; per-visitor means `ssr`.

## S2, the order
S2 lands first, in the security release. The `isr` default flip ([`35-fix-isr-default.md`](35-fix-isr-default.md)) lands after, in the next major, and touches only the `query === null` branch of `isrRequestUrl` (`render/src/render-isr-key.ts:35`). Each moves every key once, so two releases mean two re-renders, no conflict.

## S4 and S7, the head window
| Question | Answer |
|---|---|
| Why not `validateUpload` | it takes the whole body and hashes it (`storage/src/upload.ts:281`). `get` is capped at `maxGetBytes`, default `maxPutBytes` (`driver-s3.ts:145`), so promotion would refuse or buffer each large object [`25-pkg-storage-streams.md`](25-pkg-storage-streams.md) lets through. `attachment.ts:152` already rules out holding the object |
| The read | `disk.get(key, { range: [0, SNIFF_WINDOW_BYTES - 1] })`, 64 KiB. The ceiling bounds the range, never the object (`range.ts:69`). `size` 0 reads nothing. A disk with `maxGetBytes` under the window answers the existing `rangeTooLarge` |
| The check | `validateStoredHead({ key, declaredContentType, head, size }, policy)` beside `validateUpload`, both over one `assertTypeAgrees`. No checksum: promotion has none today |
| A character cut at the window's end | `sniffText` decodes with `stream: true` when `size` passes the window, so a cut is not a non-UTF-8 verdict |
| Leading whitespace | past `MAX_LEADING_WHITESPACE` (4,096 B): `X_STORAGE_TYPE_REJECTED`, both paths. Past the window nothing is seen, and no real file opens that way |
| Active markup | `activeMarkupType` reads the whole body, because XML runs a script anywhere (`upload.ts:192`). So a declared XML or `+xml` type over the window is refused at promotion (`xmlBodyUnreadable`). The server-side path, `validateUpload`, still reads all of it |

## Files
- `packages/http/src/context.ts`, `http/CLAUDE.md`, `cli/src/runtime-isr-outcome.ts`, `cli/src/runtime-render.ts`, `render/src/render-isr-key.ts`, `render/src/head.ts`, `render/src/modes.ts`.
- `storage/src/{attachment,upload,grant,driver-s3}.ts`, `realtime/src/sync-origin.ts`, `core/src/address-class.ts`, tests beside each.
- `storage/README.md`, `wiki/Routes-And-Render-Modes.md`, `wiki/Storage-And-Uploads.md`, `wiki/Known-Gaps.md`, `wiki/Upgrading.md`.
- `examples/dummy`: any `isr` or `static` `load` reading the actor. `git grep` first; the app gate proves it.

## Error codes
None new. `X_STORAGE_TYPE_REJECTED` and `validateUpload`'s other existing codes, now on promotion. S5 is the existing `upgradeOrigin` refusal.

## Semver
**Breaking, two rows; rest patch.**
- S1 Upgrading: "`isr` and `static` render as anonymous. A `load` reading the actor, a cookie or `Authorization` now sees none. A page that varies per visitor is `ssr`."
- S4, S7 Upgrading: "`promoteAttachment` reads an object's first 64 KiB, so a pending object whose bytes do not match its type refuses. An XML or `+xml` object over 64 KiB refuses at promotion: upload it through the server. Over 4,096 B of leading whitespace refuses everywhere."
- S2, S5, S6, S8: patch. S2's optional `isrKey` argument is a widening; entries re-render once.

## Done when
- The S1 probe prints no actor value for the anonymous request, and a redirect from `load` still redirects.
- A second host cannot change a visitor's canonical on any `isr` page.
- Each row's test failed before its fix. `bun test packages/cli/src/runtime-render-shared-actor.test.ts packages/storage/src/attachment.test.ts packages/storage/src/upload.test.ts`.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
