# 41 — Large uploads that resume, and objects that expire

> Part of [`overview.md`](overview.md). Depends on: [`25-pkg-storage-streams.md`](25-pkg-storage-streams.md), [`35-fix-security.md`](35-fix-security.md) (S4's head sniff). Tier: 0 (`core`), 1 (`storage`), 3 (`jobs` structural only), 5 (`cli`).

## Why
**Multipart.** `grantUpload` signs one PUT (`storage/src/grant.ts:28`), `uploadFile` sends one PUT (`storage/src/upload-client.ts:164`). A 2 GiB video on a phone restarts from byte 0 at every drop, and S3 refuses a single PUT over 5 GiB. Slice 25 scoped this out because Bun's presign cannot sign `uploadId`/`partNumber`. Probe, `presign({ method: 'PUT', query: { partNumber: '1', uploadId: 'u' } })` printed `X-Amz-Algorithm,X-Amz-Credential,X-Amz-Date,X-Amz-Expires,X-Amz-Signature,X-Amz-SignedHeaders`: query dropped. But core owns a SigV4 signer (`core/src/aws-sigv4.ts:223`) and the disk already sends signed requests for what Bun lacks (`storage/src/driver-s3-signed.ts:1`). Query-signing is one more form of that signer, not a new protocol or a dependency.

**Lifecycle.** `sweepOrphans` covers pending uploads only (`storage/src/attachment.ts:187`). Exports, temp renders and quarantined files have no expiry, a local disk has no bucket rule at all, and abandoned multipart parts bill silently forever. Bucket rules stay the operator's (axiom 7); a sweep that works on every disk is mechanism. The window is the app's, required at the call.

## Files to change
- `packages/core/src/aws-sigv4.ts` — `presignAwsUrl({ method, url, expiresInSeconds, credentials, region, service })`: query-signing, sharing `canonicalQuery` (`:143`).
- `packages/storage/src/multipart.ts` (new) — the optional capability, session types, part-size arithmetic.
- `packages/storage/src/driver.ts:135` — `StorageDriver.multipart?: MultipartCapability`, optional so a third-party driver still compiles.
- `packages/storage/src/driver-s3-multipart.ts` (new) — create, sign part, list parts, complete, abort over `driver-s3-signed.ts`.
- `packages/storage/src/driver-local-multipart.ts` (new), `driver-memory-multipart.ts` (new) — same contract, so dev and tests behave as production. Parts go through `signedUrlBase` (`driver.ts:124`).
- `packages/storage/src/driver-parity.test.ts` — the multipart row.
- `packages/storage/src/grant.ts` — `grantMultipart`.
- `packages/storage/src/upload-client.ts:164` — `UploadFileInput` gains a `multipart` form beside `grant`, which answers one signed PUT and cannot carry parts; `uploadFile` switches at `partThresholdBytes`; resumes from `listParts`.
- `packages/storage/src/expire.ts` (new) — `expireObjects`, `abortStaleUploads`, `objectPurgeTarget`.
- `packages/cli/src/runtime-storage.ts` — the local disk's part route.
- `examples/dummy/apps/web/api/` — one multipart grant; `objectPurgeTarget` in the app's `purge()`.
- `wiki/Storage-And-Uploads.md:201` (the line saying lifecycle is out of scope), `packages/storage/README.md`, `CLAUDE.md`, `wiki/Known-Gaps.md`, `wiki/Error-Codes.md`.

## Steps
1. `grantMultipart({ disk, orgId, request, policy, partBytes? })` answers `{ key, uploadId, partBytes, maxParts, expiresAt }`. Same policy gate as `grantUpload`: size against `maxBytes`, type allowlist, tenant from the actor. Part size computed so 10,000 parts covers `size`, never below the protocol's 5 MiB.
2. `signPart({ disk, key, uploadId, partNumber })` answers a URL. `listParts` answers `{ partNumber, etag, size }[]`, which is the resume. `completeUpload({ disk, key, uploadId, parts })` then `abortUpload`.
3. The upload stays pending until `promoteAttachment` (`attachment.ts:156`). Today that checks size alone (`attachment.ts:179`); after S4 of [`35-fix-security.md`](35-fix-security.md) it sniffs a 64 KiB head by ranged read, so a 2 GiB body is never loaded and a completed multipart upload gets the same check. This slice adds none.
4. `uploadFile({ file, grant, multipart?: { grant, signPart, listParts, complete, abort, partThresholdBytes?, resumeKey? } })`: each member is the app's typed action call, for the reason `grant` is (`upload-client.ts:143`): the policy is the app's. Parts go through the existing `SignedPut`. `complete` reads etags from `listParts` on the server, so the browser never needs a bucket's CORS to expose `ETag`. No `multipart`: one PUT, as today. Above `partThresholdBytes` (default 64 MiB), bounded concurrency of 4, a part retried with core's backoff, `onProgress` over bytes confirmed. A retried call with the same `resumeKey` asks `multipart.listParts` first and sends only what is missing. `resumeKey` persistence is the caller's; no browser storage here.
5. No third-party resume protocol, and no framework route on S3: bytes go straight to the bucket, so the web role never carries them (axiom 6's spirit).
6. `expireObjects({ disk, prefix, olderThanMs, keep?, clock? })` answers `{ deleted, failed, spared }` in the shape of `SweepResult` (`attachment.ts:212`). A missing `lastModified` is spared, as `sweepOrphans` does. A locked object is reported `failed`, never forced.
7. `abortStaleUploads({ disk, olderThanMs })` lists in-progress sessions.
8. `objectPurgeTarget({ name, disk, prefix, olderThanMs })` satisfies `PurgeTarget` (`jobs/src/purge.ts:32`) structurally, so `storage` imports nothing upward and the app's one `purge()` carries it. No timer in `storage`.

## Error codes
`bun run new-error-code` for each new row.

| Code | When | Fix |
|---|---|---|
| `X_STORAGE_MULTIPART_UNSUPPORTED` (new, 501) | a custom driver has no `multipart` | implement `multipart`, or use `grantUpload` |
| `X_STORAGE_UPLOAD_UNKNOWN` (new, 404) | `uploadId` not found or already finished | `grantMultipart` again |
| `X_STORAGE_PARTS_INVALID` (new, 422) | complete given a missing, unordered or wrong-etag part | `listParts`, resend the missing part |
| `X_STORAGE_TOO_LARGE` (existing) | declared or completed size past policy | raise `maxBytes` |

## Tests
- `packages/core/src/aws-sigv4.test.ts`: the published SigV4 query-signing test vector, byte for byte.
- `packages/storage/src/driver-parity.test.ts`: on all drivers, a part round-trip, complete, resume after a dropped part, abort leaves nothing.
- `packages/storage/src/upload-client.test.ts`: a part failing twice then landing; a resume sends only missing parts, counting requests; a large file with no `multipart` takes one PUT.
- `packages/storage/src/driver-s3.live.test.ts`: against the compose S3 service, a real 12 MiB three-part upload.
- `packages/storage/src/expire.test.ts` on an injected `Clock`: old deleted, new kept, locked reported, undated spared.
- `bun test packages/storage/src/expire.test.ts`

## Semver
minor. An optional member and new exports.

## Done when
- A killed then resumed upload in the live test resends fewer than all parts.
- The local disk passes the same parity suite as S3.
- `wiki/Storage-And-Uploads.md:201` no longer lists lifecycle as absent; it names `expireObjects` and leaves bucket rules to the operator.
- `bun run verify` green.
