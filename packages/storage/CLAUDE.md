# @ultimat3/storage — agent notes

Tier 1. Object storage: named disks, safe keys, signed URLs, sniffed uploads.

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else. No npm dependencies.
- Must NOT know about HTTP, entities, actions, render — a route calls `verifySignedUrl()`,
  this package never owns one. Consumers: `http`, `seo`, `admin`, `cli`.

| Rule | |
|---|---|
| Errors | `StorageError` + one factory per code in `errors.ts`; never `throw new Error` |
| New code | add to `STORAGE_ERROR_CODES` **and** `STORAGE_ERROR_TITLES` |
| Keys | every driver method starts with `assertSafeKey()`. No exceptions, no sanitising |
| Time | take a `Clock`; never `Date.now()` |
| Bytes | `Uint8Array \| ReadableStream \| Blob`. Never a base64 string |
| Exports | explicit in `src/index.ts`; no `export *` |

| File | Owns |
|---|---|
| `driver.ts` | `StorageDriver` contract + `toBytes`/`sha256Base64`/`etagOf` |
| `driver-local.ts` | dev default over `Bun.file`, `.meta/` sidecars, `Bun.Glob` listing |
| `driver-s3.ts` | `Bun.S3Client`, built lazily (import must never open a socket) |
| `path.ts` | key validation + `scopedKey`/`isWithinOrg` tenant boundary |
| `signed-url.ts` | HMAC over the constraint tuple, constant-time verify |
| `upload.ts` | magic-byte sniff + size/allowlist/checksum policy |
| `image.ts` | deterministic variant keys; byte path over core's pipeline (png/jpeg encode only) |
| | `variantKey` is the cache identity `@ultimat3/cli`'s `/media/*` route looks a variant up by — derived, never stored, so a request that misses transforms once and every later one is a disk read |
| `storage.ts` | `defineStorage` + module-level `storage()` / `disk()` |

```bash
bun test                      # from packages/storage
bun run typecheck
```

Gotchas:
- `X_NOT_IMPLEMENTED` is core's — it belongs in `STORAGE_BORROWED_ERROR_CODES` (codes, no title)
  and never in the registration call. A `hasErrorCode()` guard there would suppress the
  `X_ERROR_CODE_DUPLICATE` two owners of one code are supposed to get. Tests need `resetStorage()`
  in `beforeEach`.
- `image.ts` owns no pixels: core's `transformImageBytes`/`blurDataUrl` are the only scaler.
  Its image failures (`X_IMAGE_UNSUPPORTED`, `X_IMAGE_DECODE_FAILED`) surface unwrapped —
  wrapping them in a `StorageError` would give one failure two codes.
- `transformImage()` must encode at exactly `fitDimensions()`'s size, and passes `format`
  explicitly (`?? 'webp'`, which then rejects): bytes that disagree with the `variantKey`
  extension, or with the `width`/`height` `@ultimat3/seo` inlined, are the layout shift the
  whole path exists to prevent. That is why it derives the box itself and asks core for
  `fit: 'cover'` — core's `contain` letterboxes to the requested box, this API fits inside it.
- Bun's S3 flag is `virtualHostedStyle`; our `forcePathStyle` is its inverse.
- The signature check runs BEFORE the expiry check. Do not reorder.
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
