# 25 — Storage: a ranged stream and a streamed write

> Part of [`overview.md`](overview.md). Depends on: [`28-assets-stored-objects.md`](28-assets-stored-objects.md) (`objectResponse`, `open(range)`). Tier: 1 (`storage`), 3 (`query`), 5 (`cli`).

## Why
**Range.** `stream(key)` always starts at byte 0 (`packages/storage/src/driver.ts:151`). `/_storage` and download queries serve `Range:` by reading from 0 and discarding the prefix (`byteWindow`, reached from `objectResponse` after [`28`](28-assets-stored-objects.md)), so seeking late in a video pays for all of it. `get(key, { range })` shipped but buffers, and is capped. One adopter wrote the same prefix-drop and refuses ranges past 64 MiB so a one-byte probe cannot cost a whole object.
**Write.** `put()` buffers every body, stream included (`packages/storage/src/driver-s3.ts:230`). Probe: a 4,096-byte stream at `maxPutBytes: 1024` gives `X_STORAGE_TOO_LARGE`, `putStream` is `undefined`. One adopter caps assets at 50 MiB because more means buffering that on 768 Mi pods; another stores recordings of tens of MB.
**Config.** `S3_FORCE_PATH_STYLE` reads only `'1'` (`packages/cli/src/runtime-services.ts:199`). `true` silently selects virtual-host style. One adopter documents this as a gotcha.

Not here: presigned browser multipart. Bun's presign has no `uploadId`/`partNumber`.

## Files to change
- `packages/storage/src/driver.ts:151` — two required methods. Required, like `stat`: a driver that lacks one is a compile error. An optional argument on `stream` would be ignored silently by a third-party driver and serve the wrong bytes.
- `packages/storage/src/driver-s3.ts:301`, `driver-local.ts:298`, `driver-memory.ts:211` — implement both.
- `packages/storage/src/driver-parity.test.ts` — both methods on every driver.
- `packages/cli/src/runtime-storage.ts:181` — `open(range)` becomes `streamRange`. `objectResponse` is [`28`](28-assets-stored-objects.md)'s and does not change.
- `packages/query/src/download.ts:49`, `download-http.ts:183` — `DownloadFile.body` also takes `(range?) => BodyInit`, with `size` required beside it, so a handler passes `(range) => disk.streamRange(key, [range.start, range.end])`. `query` takes no `storage` edge. A sealed object keeps today's path: an envelope cannot be windowed.
- `packages/cli/src/runtime-services.ts:199` — refuse an unknown value.
- `wiki/Storage-And-Uploads.md`, `packages/storage/README.md`, `packages/storage/CLAUDE.md`, `wiki/Known-Gaps.md` if the row is touched.

## Steps
1. `streamRange(key, [first, last]): Promise<ReadableStream<Uint8Array>>`, inclusive like `get`'s range, screened and clamped by the helpers in `packages/storage/src/range.ts`. S3 and local through Bun's `slice(...).stream()`; memory slices.
2. `putStream(key, stream, { contentType?, maxBytes, cacheControl?, metadata? }): Promise<StorageObject>`.
   - `maxBytes` required. Count while writing; past it, abort and delete what landed.
   - S3 through Bun's multipart writer; local to a temp file then rename, keeping the commit steps in `driver-local.ts`.
   - No `checksum`, no Object Lock: both need the bytes up front. The type omits them, and a JavaScript caller passing them is refused.
3. `/_storage` uses `streamRange` for `Range:` on an unsealed object; a download reaches it through the new `body` form.
4. `S3_FORCE_PATH_STYLE`: `'1'` on, `'0'` or unset off, anything else refused at boot.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_STORAGE_TOO_LARGE` (existing) | a stream passes `maxBytes`; nothing is left behind | raise `maxBytes` on the call |
| `X_CONFIG_INVALID` (existing) | `S3_FORCE_PATH_STYLE` other than `0`/`1` | set `S3_FORCE_PATH_STYLE=1` |
| `X_STORAGE_RANGE_UNSATISFIABLE` (existing) | window past the end | re-read the size with `stat(key)` |

## Tests
- `driver-parity.test.ts`: the window's bytes equal `get`'s; an overrun leaves no object and no temp file; `putStream` round-trips.
- `packages/cli/src/runtime-storage.test.ts`: a `Range:` read calls `streamRange` and never `stream`. Fails today.
- `packages/query/src/download-http.test.ts`: the function form receives the window; a `size`-less one is refused by the type.
- `packages/storage/src/driver-s3.live.test.ts`, opt-in on `S3_ENDPOINT`: 12 MiB through `putStream`, then a window from the tail. Not on the default gate: test services run no object store.
- `bun test packages/storage/src/driver-parity.test.ts`

## Semver
**Breaking, three rows.** Upgrading: "A third-party `StorageDriver` implements `streamRange` and `putStream`. `S3_FORCE_PATH_STYLE` other than `0` or `1` refuses the boot: write `1`. `DownloadFile.body` is wider: code reading it, rather than handing it over, narrows the function form."

## Done when
- A `Range:` read near the end of a large object transfers only its window, shown on the local driver by bytes pulled.
- `putStream` of a body over `maxPutBytes` holds memory flat, measured once on the local driver and recorded in the PR.
- `bun run verify` green.
