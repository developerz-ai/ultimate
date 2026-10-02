// Single responsibility: seal ONE value under the app's master key and open it back. The wire form
// is one string, `x1.<keyId>.<iv>.<ciphertext+tag>`, AES-256-GCM through WebCrypto with a REQUIRED
// purpose bound in as additional authenticated data. `secrets.ts` is the env envelope — a file of
// many values; this is the per-value form a column or a stored session holds.

import { assert } from './assert';
import { UltimateError } from './errors';
import { SealInvalidError, SealKeyUnknownError } from './seal-errors';
import type { SealKey, SealKeyRing, SealKeySource } from './seal-keys';
import { resolveSealKeys } from './seal-keys';
import {
  decodeBase64,
  encodeBase64,
  SECRETS_ALG,
  SECRETS_IV_BYTES,
  SECRETS_TAG_BYTES,
} from './secrets';

/** The format tag. A string without it was never sealed by this function. */
export const SEAL_VERSION = 'x1';

/** What a value was sealed FOR — `entity:connections.password`, `scrape-session`. Never optional. */
export interface SealPurposeOptions extends SealKeySource {
  /** Bound into the tag: a value sealed for one purpose does not open as another. */
  readonly purpose: string;
  /**
   * A ring already resolved — `await resolveSealKeys()` — for a caller sealing or opening MANY
   * values in one operation. Without it every call finds the master key again (an environment
   * read, or a file read in a checkout); with it a 500-row page asks once. Never held past the
   * operation: a ring kept across requests would outlive a rotation.
   */
  readonly keys?: SealKeyRing | undefined;
}

const ringFor = (options: SealPurposeOptions): Promise<SealKeyRing> | SealKeyRing =>
  options.keys ?? resolveSealKeys(options);

export interface SealOptions extends SealPurposeOptions {
  /**
   * Derive the IV from the purpose and the plaintext instead of drawing it, so equal values seal
   * to equal strings and a column can be looked up by equality. It REVEALS EQUALITY to anyone who
   * can read the stored strings: two rows holding the same value are visibly the same. Never use
   * it for a low-entropy value (a boolean, a status, a PIN, a date of birth) — the handful of
   * possible ciphertexts is a lookup table. Under a rotation the same value seals differently per
   * key; `sealAll` returns every candidate.
   */
  readonly deterministic?: boolean | undefined;
}

// 12 bytes are exactly 16 unpadded base64url characters; a 16-byte tag alone is 22.
const SEALED = /^x1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;

const encoder = new TextEncoder();

const toUrl = (bytes: Uint8Array<ArrayBuffer>): string =>
  encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function fromUrl(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  return decodeBase64(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '='));
}

/** A fresh copy either way, so a caller's buffer is never the one WebCrypto is handed. */
const bytesOf = (plaintext: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof plaintext === 'string' ? encoder.encode(plaintext) : new Uint8Array(plaintext);

/**
 * The bytes the tag covers besides the ciphertext: the format, the algorithm, the key id and the
 * purpose. A string moved to another column, or relabelled with another key id, fails the tag.
 */
const additionalData = (keyId: string, purpose: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(
    `ultimate.seal|${SEAL_VERSION}|alg=${SECRETS_ALG}|kid=${keyId}|purpose=${purpose}`,
  );

function requirePurpose(purpose: unknown): asserts purpose is string {
  assert(
    typeof purpose === 'string' && purpose.length > 0,
    'seal() and open() were called without a purpose, and the purpose is what stops a value sealed for one column opening as another',
    "pass purpose: '<what the value is for>' — seal(value, { purpose: 'entity:<table>.<column>' })",
  );
}

/**
 * The deterministic IV: HMAC-SHA-256 over the length-prefixed purpose and the plaintext, cut to
 * GCM's 96 bits. Length-prefixed so (`a`, `bc`) and (`ab`, `c`) are different inputs. A repeated
 * (key, IV) pair then means a repeated (purpose, plaintext) — the same ciphertext, which is the
 * mode's stated leak and not a nonce reuse across two messages.
 */
async function derivedIv(
  key: SealKey,
  purpose: string,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const label = encoder.encode(purpose);
  const material = new Uint8Array(4 + label.length + plaintext.length);
  new DataView(material.buffer).setUint32(0, label.length);
  material.set(label, 4);
  material.set(plaintext, 4 + label.length);
  const mac = await crypto.subtle.sign('HMAC', key.mac, material);
  return new Uint8Array(mac).slice(0, SECRETS_IV_BYTES);
}

async function sealUnder(
  key: SealKey,
  plaintext: Uint8Array<ArrayBuffer>,
  purpose: string,
  deterministic: boolean,
): Promise<string> {
  const iv = deterministic
    ? await derivedIv(key, purpose, plaintext)
    : crypto.getRandomValues(new Uint8Array(SECRETS_IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: additionalData(key.id, purpose),
      tagLength: SECRETS_TAG_BYTES * 8,
    },
    key.aes,
    plaintext,
  );
  return `${SEAL_VERSION}.${key.id}.${toUrl(iv)}.${toUrl(new Uint8Array(sealed))}`;
}

/**
 * Seal one value under the CURRENT master key — the one `x secrets` manages, found where
 * `installSecrets()` finds it.
 *
 * ```ts
 * const stored = await seal(password, { purpose: 'entity:connections.password' });
 * const password = await openText(stored, { purpose: 'entity:connections.password' });
 * ```
 *
 * `X_SEAL_KEY_MISSING` when there is no key: the plaintext is never returned in its place.
 */
export async function seal(plaintext: string | Uint8Array, options: SealOptions): Promise<string> {
  requirePurpose(options.purpose);
  const ring = await ringFor(options);
  return sealUnder(
    ring.current,
    bytesOf(plaintext),
    options.purpose,
    options.deterministic === true,
  );
}

/**
 * The DETERMINISTIC seal of one value under every declared key, current first. During a rotation
 * a row written before it holds the old key's string and a row written after holds the new one's,
 * so an equality lookup has to match either: `where column in (…sealAll(value))`. Outside a
 * rotation this is one string. Uniqueness cannot be held across keys — one value has two forms.
 */
export async function sealAll(
  plaintext: string | Uint8Array,
  options: SealPurposeOptions,
): Promise<readonly string[]> {
  requirePurpose(options.purpose);
  const ring = await ringFor(options);
  const bytes = bytesOf(plaintext);
  return Promise.all(ring.keys.map((key) => sealUnder(key, bytes, options.purpose, true)));
}

interface SealedParts {
  readonly keyId: string;
  readonly iv: string;
  readonly body: string;
}

function partsOf(value: unknown): SealedParts | undefined {
  const match = typeof value === 'string' ? SEALED.exec(value) : null;
  const [keyId, iv, body] = [match?.[1], match?.[2], match?.[3]];
  if (keyId === undefined || iv === undefined || body === undefined) return undefined;
  // No whole number of bytes encodes to 4n+1 base64 characters: a truncated write, not a value.
  return body.length % 4 === 1 ? undefined : { keyId, iv, body };
}

const malformed = (sealed: unknown, purpose?: string): SealInvalidError =>
  new SealInvalidError({
    reason: 'malformed',
    purpose,
    length: typeof sealed === 'string' ? sealed.length : 0,
  });

/**
 * Whether a value has the SHAPE of a sealed string. Not a claim that it opens: it exists so a
 * caller migrating a plaintext column can tell an unsealed legacy row from a sealed one without
 * attempting a decryption — `open()` itself never falls back to the raw string.
 */
export function isSealed(value: unknown): value is string {
  return partsOf(value) !== undefined;
}

/** The id of the key a sealed string names — what a re-seal `backfill()` compares to the current. */
export function sealedKeyId(sealed: string): string {
  const parts = partsOf(sealed);
  if (parts === undefined) throw malformed(sealed);
  return parts.keyId;
}

/**
 * Open a sealed string to its bytes. Three refusals, in the order the facts become knowable: the
 * string is not a sealed value (`X_SEAL_INVALID`), it names a key this process does not declare
 * (`X_SEAL_KEY_UNKNOWN` — read off the string before any decryption is attempted, so a rotation
 * is never reported as tampering), or the tag rejected it under the purpose given
 * (`X_SEAL_INVALID`).
 */
export async function open(
  sealed: string,
  options: SealPurposeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  requirePurpose(options.purpose);
  const parts = partsOf(sealed);
  if (parts === undefined) throw malformed(sealed, options.purpose);
  const { keyId, iv, body } = parts;
  const ring = await ringFor(options);
  // A lookup by the id the string names. An id is public — it is in every sealed value — and a
  // `Map` says so: nothing here is compared byte by byte against a secret.
  const key = ring.byId.get(keyId);
  if (key === undefined) {
    throw new SealKeyUnknownError({
      keyId,
      declared: ring.keys.map((one) => one.id),
    });
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromUrl(iv),
        additionalData: additionalData(keyId, options.purpose),
        tagLength: SECRETS_TAG_BYTES * 8,
      },
      key.aes,
      fromUrl(body),
    );
    return new Uint8Array(plaintext);
  } catch {
    // No `sourceError`, for `openSecrets`' reason: WebCrypto's OperationError says nothing more.
    throw new SealInvalidError({ reason: 'unauthenticated', purpose: options.purpose, keyId });
  }
}

/**
 * `open()` for a value that was sealed from a string. Bytes that are not UTF-8 are refused rather
 * than decoded with replacement characters: a caller would store the repaired text back.
 */
export async function openText(sealed: string, options: SealPurposeOptions): Promise<string> {
  const bytes = await open(sealed, options);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UltimateError({
      code: 'X_INVARIANT',
      cause: `the value opened to ${bytes.length} byte(s) that are not UTF-8 text, so it was sealed from bytes and openText() cannot return it`,
      fix: 'call open() instead of openText() for a value sealed from a Uint8Array',
    });
  }
}
