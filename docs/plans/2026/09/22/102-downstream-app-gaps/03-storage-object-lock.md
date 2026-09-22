# 03 — Storage: checksum, retention and legal hold on PUT

> Part of [`overview.md`](overview.md). Depends on: 01 (`signAwsRequest`). Tier: 1.

Rule: every s3 PUT carries an integrity checksum, always. Retention and legal hold are per-object
`PutOptions`, and they are either honoured or refused, never dropped.

Today `put()` hashes the bytes locally (`packages/storage/src/driver-s3.ts:244-252`) and then calls
`.write(bytes, { type })` (`:256`). The digest is compared locally and never sent. `Bun.S3Client`
has no option for checksum, metadata, `x-amz-object-lock-*` or SSE headers
(`packages/storage/README.md:37-40,72-78`).

## Files to change
- `packages/storage/src/driver.ts:52-58` — `PutOptions` gains:
  - `retention?: { mode: 'COMPLIANCE' | 'GOVERNANCE'; until: Instant }`
  - `legalHold?: boolean`

  `StorageObject` gains `retention?`/`legalHold?` when the driver can read them.
- `packages/storage/src/driver-s3-put.ts` (new, < 200 LOC) — one SigV4-signed `PUT` through `fetch`, via `signAwsRequest` from core. It sends:
  - `x-amz-checksum-sha256` (the base64 digest already computed at `driver-s3.ts:249-252`)
  - `x-amz-sdk-checksum-algorithm: SHA256`
  - `content-type`
  - `x-amz-meta-*`, `cache-control`, `x-amz-server-side-encryption*`, `x-amz-object-lock-mode`/`-retain-until-date`, `x-amz-object-lock-legal-hold`

  Endpoint and path-style come from the same `S3DriverOptions` `buildClient` reads.
- `packages/storage/src/driver-s3.ts:190-210,244-258` — `put` routes through `driver-s3-put.ts` for every write. There is one PUT path, so `Bun.S3Client.write` is no longer used for `put` (`copy` keeps it). This deletes `refuseUnsupportedPut`'s metadata, cache-control and SSE refusals, since the headers are now sendable. Remove the matching `X_NOT_IMPLEMENTED` rows from the README.
- `packages/storage/src/driver-s3.ts` — `retentionOf(key)` through a signed `GET ?retention` and `?legal-hold`. It returns `undefined` on a bucket without Object Lock.
- `packages/storage/src/driver-local.ts` — record `retention`/`legalHold` in the `.meta/` sidecar. `delete()` of an object under retention or hold is refused with `X_STORAGE_DELETE_FAILED`, which is what S3 answers, so dev and test behave like the bucket.
- `packages/storage/src/errors.ts` — `X_STORAGE_RETENTION_INVALID`, for a `until` in the past, or GOVERNANCE/COMPLIANCE on a driver that cannot hold it. Add through `bun run scripts/new-error-code.ts X_STORAGE_RETENTION_INVALID --package storage ...`.
- `packages/storage/README.md` §Drivers and §SSE — rewritten. A new §"Write-once objects" says:
  - bucket default retention plus per-object `retention`;
  - compliance mode cannot be shortened by anyone;
  - how to extend with a second `PUT ?retention`, which stays out of scope and is documented as an `aws s3api` fix line.

## Steps
1. Write `driver-s3-put.ts` against the fixture driver (`driver-s3-fixture.ts`). Assert the exact header set.
2. Switch `put` over. Keep the size ceiling and the stream-cancel behaviour (`README.md:61-67`) unchanged.
3. Add the local-disk emulation.
4. Add a live test, `driver-s3.live.test.ts`. It is opt-in by suffix and reads `S3_OBJECT_LOCK_BUCKET`. It PUTs with COMPLIANCE for 1 day into a bucket created with Object Lock, then asserts that `retentionOf` round-trips and that a delete is refused.

## Tests
- `bun test packages/storage/src/driver-s3-put.test.ts packages/storage/src/driver-local.test.ts`.
- The checksum header is present on every PUT, including one with no options.
- A tampered body in the fixture produces the S3 `BadDigest` shape and maps to `X_STORAGE_CHECKSUM_MISMATCH`.
- `bun test packages/storage/src/driver-s3.live.test.ts` against a real bucket (not in the default gate).

## Done when
- No `put` path sends without `x-amz-checksum-sha256`.
- `metadata`, `cacheControl`, `serverSideEncryption`, `retention` and `legalHold` are honoured on s3 and on local.
- The live test is green once against an Object Lock bucket, with its run id recorded in `status.yml` evidence.
