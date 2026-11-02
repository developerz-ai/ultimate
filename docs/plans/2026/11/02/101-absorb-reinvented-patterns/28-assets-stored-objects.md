# 28 — A stored object's variants and its one response

> Part of [`overview.md`](overview.md). Depends on: none. [`25-pkg-storage-streams.md`](25-pkg-storage-streams.md) and S4 of [`35-fix-security.md`](35-fix-security.md) build on it. Tier: 1 (`storage`), 2 (`http`), 3 (`query`), 5 (`cli`).

## Why
`/media` looks a variant up before it looks at the source (`packages/cli/src/runtime-assets.ts:137`), and the variant key names neither the source's bytes nor its encoding. Four defects, all reproduced 2026-11-02 through the real route handler on a local disk:

| Defect | Probe output |
|---|---|
| Overwrite: the variant outlives the bytes | source 640x320, `?w=320` is 320x160; source replaced by 640x640; `?w=320` still 320x160 |
| Delete: a deleted source keeps serving | `exists` false; `?w=320` answers `200`, 279 B; `org/o1/p/x.png@w320.webp` left on disk. An erasure request is not honoured |
| One key, two encodings (`variantKey` defaults to `webp`, `storage/src/image.ts:98`; the driver keeps the source's) | `?w=320` then `?w=320&f=webp` both answer `image/png` 279 B; reversed, both `image/webp` 196 B. `responsiveImage` puts both URLs on one page (`seo/src/images.ts:228-253`), so the order of first requests decides the bytes |
| Shared key, `public, immutable` | `brand/l.png` answers `public, max-age=31536000, immutable` on an `auth: 'required'` route. The key is not content-addressed, the comment at `runtime-assets.ts:46` claims it is, and `cache-headers` leaves `immutable` alone. A CDN then serves it to strangers for a year and never refreshes it |

Second half: adopters cannot reach the correct response. `storageResponse` (`runtime-storage.ts:199`) is unexported. One adopter wrote 127 LOC for the same type, validator, range and sandbox rules, with a private range parser. Another wrote 79 LOC that buffers through `get` and answers no range. Both serve objects a stranger may fetch, whose authorization is app state (a published row), so `shared` cannot express them: axiom 8. No adopter uses `/media` or `responsiveImage`.

## Files to change
- `packages/storage/src/image.ts:47` — `ImageTransform.revision?: string`, written into the key as `r<8 hex>`. Pure, as `variantKey` is. `:98` unchanged for existing callers.
- `packages/storage/src/attachment.ts` — `deleteVariants({ disk, key })`, answering `{ deleted, failed }` as `sweepOrphans` does.
- `packages/cli/src/runtime-assets.ts:120-166` — stat first, then key; see Steps.
- `packages/cli/src/runtime-assets.ts:46-51,100-101` — delete `IMMUTABLE_IMAGE` and `mediaCache`; every answer is `AUTHORIZED_OBJECT_CACHE` plus an `etag`.
- `packages/http/src/object-response.ts` (new) — `objectResponse`, moved from `runtime-storage.ts:185-243`. The move happens here; `25` builds on it.
- `packages/http/src/stored-object-headers.ts` — moved from `packages/cli/src/`; `isInlineSafe` with it.
- `packages/cli/src/runtime-storage.ts:181,199` — calls `objectResponse`; `open(range)` answers `byteWindow(await driver.stream(key), range)` until `25` gives it a real window.
- `packages/query/src/download-http.ts:186-226` — the third copy of the range rules. `fileResponse` delegates; `bodyOf` stays as the adapter over a `Uint8Array`, `Blob` or stream.
- `packages/cli/src/storage-surfaces.test.ts` — `IMMUTABLE` row goes.
- `wiki/Storage-And-Uploads.md:164-170` — names `objectResponse` as the way to serve a stranger's object; `deleteVariants` beside `sweepOrphans`.
- `packages/{storage,http}/README.md`, `CLAUDE.md`.

## Steps
1. `transformedVariant`: `disk.stat(key)` first. Absent is `X_STORAGE_NOT_FOUND`, before any variant is consulted. That closes the deleted-source read on every disk.
2. The format is resolved before the key: `query.format`, else the stored `contentType` mapped through a new `variantFormatOf(contentType)` (`png`, `jpeg`, `webp`). Unmappable (a `gif`) is served, never stored. Closes the collision.
3. The key carries `revision: object.etag.slice(0, 8)`. An empty etag (`storage/CLAUDE.md`: "an unknowable etag is `''`") is served, never stored. Closes the overwrite.
4. The answer carries `etag` = source etag + the transform, and answers 304 through `etagMatches`.
5. `deleteVariants` pages `list({ prefix: `${key}@` })`. A variant keeps the source's prefix, so an org-wide erasure by prefix already collects them; say so in the wiki.
6. `objectResponse(request, { object, open }, { cache?, headers? })` in `http`, structural over `{ contentType, size, etag?, lastModified? }`: `http` still imports no storage. `open(range?)` answers exactly those bytes as a `BodyInit`, so a disk can serve a window instead of dropping a prefix. `request` needs only `header(name)`. `cache` omitted is today's behaviour. `headers` replaces the stored-object sandbox rule for a caller with its own, as a download has. No `etag`: no 304. Exported from `@ultimat3/http`; `http/CLAUDE.md` file table gains the row.
7. `fileResponse` becomes async and takes the request. A file of unknown size keeps its one branch, whole with `accept-ranges: none`: no window to serve.
8. Old-revision variants of an overwritten source are bytes nobody reads, removed by `deleteVariants` or a bucket lifecycle rule. Documented, not swept: retention is app-chosen.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_STORAGE_NOT_FOUND` (existing) | a variant of a deleted source | `disk.exists(key)`, then re-upload or drop the URL |

## Tests
Each fails on `main` with the probe's output.
- `packages/cli/src/runtime-assets-variants.test.ts`, unit over a local disk: overwrite then `?w=320` shows the new height; delete then `?w=320` is `X_STORAGE_NOT_FOUND`; both request orders give `image/png` for `?w=320` and `image/webp` for `?w=320&f=webp`; a shared key is not `public`; a second request with `if-none-match` is 304.
- `packages/storage/src/image.test.ts`: two revisions, two keys; no revision, the key is byte-identical to today's.
- `packages/storage/src/attachment.test.ts`: `deleteVariants` reports a refused delete in `failed`, and leaves a neighbour `x.png2@w1.webp`.
- `packages/http/src/object-response.test.ts`: 200, 206, 304, 416, sandbox on `text/html`, inline on `image/png`, the `cache` hint applied; `open` receives the parsed range; `headers` replaces the sandbox rule.
- `packages/query/src/download-http.test.ts`: existing cases unchanged through the delegation.
- `bun test packages/cli/src/runtime-assets-variants.test.ts`

## Semver
Breaking, one row. `/media` on a shared key stops answering `public, immutable`. Upgrading: a CDN rule keyed on that header misses from now on; a public image belongs in `apps/web/site/assets/` via `asset()`, or behind an app route using `objectResponse`. Existing variants under old keys go unread and are re-minted once. `storedObjectHeaders` was never public, so its move breaks nothing.

## Done when
- The four probe sequences answer correctly.
- `git grep -n storageResponse packages/cli/src` shows one thin call, and `git grep -n parseByteRange packages/query/src` nothing.
- `wiki/Storage-And-Uploads.md` names one way to serve a stranger an object.
