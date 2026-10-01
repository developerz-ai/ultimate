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
4. Three failures, three codes, each with a cause and a runnable fix:

| Code | Cause it states | Fix it carries |
|---|---|---|
| `X_SEAL_KEY_MISSING` | no master key is configured | `x secrets init` |
| `X_SEAL_KEY_UNKNOWN` | the value names key id `<id>`, which is not among the declared keys | re-declare the retired key until the re-seal `backfill()` has finished; the cause lists the declared ids |
| `X_SEAL_INVALID` | the value did not authenticate under key `<id>` for purpose `<purpose>` — AEAD cannot tell a wrong purpose from tampering, so the cause names both | `x secrets show` to confirm the key id in use; the value itself is unrecoverable and must be re-entered |

   Never return garbage; never fall back to the raw string.
5. Register all three with `bun run new-error-code <CODE> --package core --title '…' --fix '…'`.
   Classify all three terminal through `registerErrorRetry` (`packages/core/src/error-retry.ts:95`).
6. `open()` returns `Uint8Array`; `openText()` is the string spelling. No JSON helper.
7. **Key ring** (Active Record Encryption's `previous:`). `seal()` always writes under the current
   key; `open()` selects by the `keyId` in the string, from the current key plus any retired keys
   the app still declares. Rotation is then: add a key, keep the old one declared until a
   `backfill()` has re-sealed, drop it. A `keyId` nobody declares is `X_SEAL_KEY_UNKNOWN`.
   `x secrets rotate` already exists (`packages/cli/src/cmd-secrets-spec.ts:12`); read what it
   does to the env envelope and extend that one command, never add a second rotation verb.
8. **Deterministic mode** (`deterministic: true`): the IV is derived by HMAC from purpose and
   plaintext, so equal values seal equal. It exists for slice 03's lookup columns only; state in
   the doc comment that it reveals equality and must never be used for a low-entropy value.
   **During a rotation window** a deterministic value sealed under the old key differs from the
   same value under the new one. `sealAll(plaintext)` returns one candidate per declared key so a
   lookup can match either; uniqueness cannot be held across keys — slice 03 step 6 states what
   that costs.

## Tests
- `packages/core/src/seal.test.ts`: round trip; wrong purpose refused; one flipped byte refused;
  a missing key names the fix; two seals of one value differ (fresh IV); a value sealed under a
  retired key opens while that key is declared and refuses once it is not; deterministic seals of
  one value are equal and of two values differ.
- Command: `bun test packages/core/src/seal.test.ts`.

## Done when
- `seal` / `open` / `openText` exported from `@ultimat3/core`; all three codes in `wiki/Error-Codes.md`.
- `bun run boundaries` green: no package above tier 0 imports Web Crypto for sealing.
