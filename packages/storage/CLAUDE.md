# @ultimat3/storage — agent notes

Tier 2. Object storage: named disks, safe keys, signed URLs, sniffed uploads.

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
| `image.ts` | deterministic variant keys; encode path throws `X_NOT_IMPLEMENTED` |
| `storage.ts` | `defineStorage` + module-level `storage()` / `disk()` |

```bash
bun test                      # from packages/storage
bun run typecheck
```

Gotchas:
- `X_NOT_IMPLEMENTED` is core's — keep the `hasErrorCode()` guard in the registration loop,
  or importing throws `X_ERROR_CODE_DUPLICATE`. Tests need `resetStorage()` in `beforeEach`.
- Bun's S3 flag is `virtualHostedStyle`; our `forcePathStyle` is its inverse.
- The signature check runs BEFORE the expiry check. Do not reorder.
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
