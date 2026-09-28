# 01 — Core, money, storage

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0–1.

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `packages/core/src/cursor.ts:52` | `currentSecret()` uses `??` — `ULTIMATE_CURSOR_SECRET=` becomes an empty HMAC key; `usesDevCursorSecret()` says `false`, boot check passes; cursors forgeable with key `''`; `keyed-fingerprint.ts` derives from the same secret | CONFIRMED, high |
| `packages/money/src/format.ts:141` | `trimZeroFraction` sets `minimumFractionDigits: 0` → `money(1250,'USD')` renders `$12.5`; contract is "drop `.00` on whole amounts" | CONFIRMED, med |
| `packages/storage/src/driver-local.ts:218` | `put('a')` then `put('a/b')` (or reverse) throws raw `ENOTDIR`/`EISDIR`; S3 allows it | CONFIRMED, med |
| `packages/storage/src/driver-local.ts:283-284` | `put` writes bytes then sidecar in place: concurrent puts leave A's etag over B's bytes; readers see truncated files | PLAUSIBLE, low |
| `packages/storage/src/signed-url.ts:74` | `canonicalRequest` omits the disk base; all local disks share `STORAGE_SIGNING_SECRET` (`driver-local.ts:189-198`) | PLAUSIBLE, low — verify two disks can mount at distinct bases first |

## Steps
1. `cursor.ts`: treat `''` as unset (follow `usesDevStorageSecret`, `driver-local.ts:62`); `usesDevCursorSecret` reports it so `assertNoDevSecretsOutsideLocal` refuses outside local.
2. `format.ts`: keep min = max = currency exponent, add `trailingZeroDisplay: 'stripIfInteger'`.
3. `driver-local.ts` prefix keys: store objects under a suffixed on-disk name so file and dir never collide (keeps S3 parity). If rejected as too invasive, minimum is a coded error: `bun run new-error-code X_STORAGE_KEY_CONFLICT --package storage --title '…' --fix '…'`, wrapped like `deleteFailed` (`:165`).
4. `driver-local.ts` atomic put: write bytes + sidecar to temp names in the same dir, `rename` into place (sidecar last).
5. `signed-url.ts`: include `signedUrlBaseFor(disk)` in the canonical string only if step-0 check shows distinct bases are possible; otherwise record "not reachable" in `status.yml` `notes`.

## Tests
- `packages/core/src/dev-secrets.test.ts` — empty env var → `usesDevCursorSecret() === true`; boot refuses outside local.
- `packages/money/src/format.test.ts` — `1250 USD` → `$12.50`, `1200 USD` → `$12`.
- `packages/storage/src/driver-local.test.ts` — prefix pair round-trips (or refuses with the new code); two concurrent puts leave a consistent etag/bytes pair.
- `packages/storage/src/signed-url.test.ts` — URL for disk A refused on disk B (if step 5 applies).
- `bun test packages/core packages/money packages/storage`

## Not a bug (don't reopen)
- Storage keys: `..`, encoded separators, NUL, leading `/` refused; constant-time signature compare; dev secret refused outside local.
- money `allocate`/`convert`/`rounding`; S3 presign ignoring `maxBytes` (documented, `driver.ts:86-92`).

## Done when
- The four tests above fail on `fcfe31dc` and pass; `bun run verify` steps `unit`, `errors` green.
