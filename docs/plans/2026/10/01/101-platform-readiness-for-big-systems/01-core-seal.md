# 01 — Core: seal one value

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Rule: one function seals a value under the app's master key; nothing above tier 0 writes its own
AES call.

## Files to change
- `packages/core/src/seal.ts` (new) — `seal(plaintext, { purpose })` and `open(sealed, { purpose })`.
  Its own file: `packages/core/src/secrets.ts` is 292 lines and is the env envelope, a different
  subject.
- `packages/core/src/secrets.ts:15-22` — reuse `SECRETS_ALG`, `SECRETS_IV_BYTES`, `SECRETS_TAG_BYTES`,
  `parseMasterKey` (`:88`), `masterKeyId` (`:105`). No second set of constants.
- `packages/core/src/index.ts` — named re-exports.
- `packages/core/README.md`, `packages/core/CLAUDE.md` — the new public API and its boundary.

## Steps
1. Read how `sealSecrets` (`packages/core/src/secrets.ts:167`) locates the master key. `seal()`
   resolves the same key from the same place; it adds no new variable.
2. Wire format, one string: `x1.<keyId>.<iv>.<ciphertext+tag>`, base64url. `keyId` is
   `masterKeyId`'s, so a rotated key is a detectable mismatch, never a garbled read.
3. `purpose` is REQUIRED and bound as additional authenticated data: a value sealed for
   `scrape-session` does not open as `entity:connections.password`.
4. No key → `X_SEAL_KEY_MISSING`, fix names the `x secrets` command that creates one. Wrong key,
   wrong purpose or a tampered string → `X_SEAL_INVALID`; never return garbage.
5. Register both with `bun run new-error-code <CODE> --package core --title '…' --fix '…'`.
   Classify both terminal through `registerErrorRetry` (`packages/core/src/error-retry.ts:95`).
6. `open()` returns `Uint8Array`; `openText()` is the string spelling. No JSON helper.

## Tests
- `packages/core/src/seal.test.ts`: round trip; wrong purpose refused; one flipped byte refused;
  a missing key names the fix; two seals of one value differ (fresh IV).
- Command: `bun test packages/core/src/seal.test.ts`.

## Done when
- `seal` / `open` / `openText` exported from `@ultimat3/core`; both codes in `wiki/Error-Codes.md`.
- `bun run boundaries` green: no package above tier 0 imports Web Crypto for sealing.
