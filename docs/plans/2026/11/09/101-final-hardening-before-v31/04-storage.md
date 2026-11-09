# 04 — Storage: correct S3 signing, driver parity, uploads that stream

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`storage`), 0 (`core/src/aws-sigv4.ts`, owned here), 5 (`cli/src/runtime-storage*.ts`, owned here for this sweep). `Bun.serve` body ceiling is [`08`](08-http.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| S1 | **High** | `storage/src/driver-s3-signed.ts:255` → `core/src/aws-sigv4.ts:275` | a space in a signed query value is sent as `+` then `%2B`. Proved: `prefix:'my file/'` sent as `my%2Bfile%2F`. `listS3Uploads` (`driver-s3-multipart.ts:153,172`) pages by `key-marker`; a key with a space skips uploads, so they are never aborted and keep billing | in `signAwsRequest`, normalise as `presignAwsUrl` does at `aws-sigv4.ts:353`: `new URLSearchParams(url.search).toString().replaceAll('+','%20')` before `canonicalQuery` |
| S2 | Med | `storage/src/driver-s3.ts:359-366` | `copy()` without `ifMatch` goes through Bun `write(S3File,{type})`: drops `cacheControl` and `x-amz-meta-*`. Local (`driver-local.ts:315-321`) and memory (`driver-memory.ts:281`) keep both | always `signedCopy` (CopyObject, directive COPY), `x-amz-copy-source-if-match` only with `ifMatch`. Over 5 GiB: multipart copy (UploadPartCopy) or a coded refusal naming it |
| S3 | Med | `cli/src/runtime-storage.ts:193-198` (`readStorageObject`), `driver-local.ts:284-298`, S3 `stream` | `stat` then `stream` are two calls; an overwrite between them serves old ETag/length with new bytes, and Range checks the old size | optional `etag` on stream options: S3 sends `If-Match`, retries once on 412; local opens the file, then stats and compares the stored ETag |
| S4 | Med (High for large data) | `cli/src/runtime-storage-upload.ts:62` (`readWithinLimit`) | a signed upload (single PUT or one part) is buffered whole before the disk; memory per upload = its size | pipe the body into `disk.putStream(key, body, { maxBytes })`; tee only the first 8 KiB for content sniffing |
| S5 | Med | `storage/src/driver-s3-put-stream.ts` (`sendPart`) | parts sent one at a time; each held twice; part size from the declared ceiling (`maxBytes/10000`), so a 1 TB ceiling means 100 MB parts | 2–4 parts in flight (reuse `PART_CONCURRENCY`), part size from a target (8–16 MiB, grown only past 10,000 parts), chunks written into a preallocated buffer |
| S6 | Low | `storage/src/driver-local-stream.ts` | `await open.flush()` per chunk: 1 GiB in 64 KiB chunks 4.78 s vs 1.24 s plain | flush when ≥ 1 MiB buffered and at close |
| S7 | Low | `storage/src/driver-memory.ts:212-233` | `putStream` holds three copies | concatenate once, hand ownership to `commit` |
| S8 | Low (verify on Windows CI) | `storage/src/path.ts:62-70` | no refusal of a trailing `.`, `:`, or device names (`CON`, `NUL`, …). Win32 drops trailing dots, so `.meta./a` may reach the reserved sidecar dir; `a:b` is an NTFS stream | refuse all three in `unsafeReason` for every driver |
| S9 | Low | `storage/src/driver-s3-range.ts` (`errorMessage`) | `String(thrown)` in a cause (banned pattern) | `renderThrowable` |

## Files to change
- `packages/core/src/aws-sigv4.ts`, `packages/storage/src/driver-s3-signed.ts` — S1.
- `packages/storage/src/driver-s3.ts`, `driver-s3-copy.ts` — S2.
- `packages/storage/src/driver.ts` (stream options type), `driver-local.ts`, `driver-s3-range.ts` / stream path, `packages/cli/src/runtime-storage.ts` — S3, S9.
- `packages/cli/src/runtime-storage-upload.ts` — S4.
- `packages/storage/src/driver-s3-put-stream.ts` — S5.
- `packages/storage/src/driver-local-stream.ts` — S6. `driver-memory.ts` — S7. `path.ts` — S8.
- `packages/storage/README.md` — copy limits, upload memory bound.

## Tests
- `driver-s3-signed.test.ts`: sent URL for `prefix:'a b'` contains `prefix=a%20b`; a fixture listing page whose key contains a space pages correctly.
- `driver-contract.test.ts` (all three drivers): copy keeps `cacheControl` and metadata; overwrite between `stat` and `stream` → consistent bytes and ETag.
- `runtime-storage-upload.test.ts`: 200 MiB through the route on the local disk, peak RSS growth < 64 MiB.
- `driver-s3-put-stream.test.ts`: fixture S3 with 50 ms per part → wall time drops with concurrency; bytes held ≤ concurrency × part size.
- `path.test.ts`: `.meta.`, `a:b`, `CON`, `nul.txt` refused.
- `bun test packages/storage packages/cli/src/runtime-storage*.test.ts`; live S3 suites run in CI `gate (live)`.

## Done when
- The [`19`](19-conformance-suites.md) `storageDriverConformance` (written later) passes against memory, local and S3 with these cases inside it.
