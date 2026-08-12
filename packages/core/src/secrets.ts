// Single responsibility: the encrypted-secrets envelope. Seal a flat map of env values under a
// 32-byte master key and open one back, AES-256-GCM through WebCrypto only — a fresh 12-byte IV per
// seal, the 128-bit tag verified on open, and the envelope's own header bound in as additional
// authenticated data so a downgraded `alg` or a swapped key id fails the tag instead of decrypting.

import {
  SecretsFileInvalidError,
  SecretsKeyInvalidError,
  SecretsKeyMismatchError,
  SecretsPlaintextInvalidError,
  SecretsTamperedError,
} from './secrets-errors';

export const SECRETS_VERSION = 1;
export const SECRETS_ALG = 'AES-256-GCM';
export const SECRETS_KEY_BYTES = 32;
export const SECRETS_KEY_HEX_LENGTH = SECRETS_KEY_BYTES * 2;
/** GCM's standard nonce. 96 bits is the size the construction is defined for; never reused. */
export const SECRETS_IV_BYTES = 12;
export const SECRETS_TAG_BYTES = 16;
/** Truncated to 64 bits: enough to name a key, far too little to attack the 256-bit key behind it. */
export const SECRETS_KEY_ID_LENGTH = 16;

/** A secret's name is the env var it becomes — there is no second namespace. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

const HEX_KEY = /^[0-9a-f]+$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decrypted values: env var name to value. Flat on purpose — see `installSecrets`. */
export type SecretValues = Readonly<Record<string, string>>;

/** The committed file, header first so `git diff` shows a rotation as a one-line `kid` change. */
export interface SecretsEnvelope {
  readonly v: number;
  readonly alg: string;
  /** Non-secret fingerprint of the master key this was sealed with. */
  readonly kid: string;
  readonly iv: string;
  readonly ct: string;
}

/** Where each half came from, so an error names the file the reader has to act on. */
export interface SecretsLocation {
  /** The envelope's path, or the name of whatever produced it. */
  readonly file: string;
  /** The master key's origin — an env var name, or the key file's path. */
  readonly key: string;
}

const encoder = new TextEncoder();

function encodeHex(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function decodeHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// `btoa`/`atob` rather than node:buffer — both are standard globals, and a chunk loop avoids the
// stack blow-up `String.fromCharCode(...bytes)` hits on a spread of any size.
function encodeBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh master key: 32 CSPRNG bytes, hex. The only thing that must never reach the repo. */
export function generateMasterKey(): string {
  return encodeHex(crypto.getRandomValues(new Uint8Array(SECRETS_KEY_BYTES)));
}

/** 64 lowercase hex characters, or `X_SECRETS_KEY_INVALID`. Whitespace is trimmed, never repaired. */
export function parseMasterKey(raw: string, at: string): Uint8Array<ArrayBuffer> {
  const hex = raw.trim();
  if (hex.length !== SECRETS_KEY_HEX_LENGTH || !HEX_KEY.test(hex)) {
    throw new SecretsKeyInvalidError({
      at,
      found: hex.length,
      expected: SECRETS_KEY_HEX_LENGTH,
    });
  }
  return decodeHex(hex);
}

/**
 * The key's public name. Domain-separated so this digest can never be replayed as a digest of the
 * key computed for any other purpose, and truncated to 16 hex characters because its only job is
 * telling two keys apart in a committed file and in an error message.
 */
export async function masterKeyId(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const domain = encoder.encode('ultimate.secrets.kid.v1');
  const material = new Uint8Array(domain.length + key.length);
  material.set(domain, 0);
  material.set(key, domain.length);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return encodeHex(new Uint8Array(digest)).slice(0, SECRETS_KEY_ID_LENGTH);
}

/**
 * The bytes the tag covers besides the ciphertext. Binding the header means an attacker who can
 * write the file cannot downgrade `alg`, renumber `v` or claim a different `kid` without the tag
 * catching it — the fields that decide how the body is read are authenticated with the body.
 */
const additionalData = (header: Omit<SecretsEnvelope, 'iv' | 'ct'>): Uint8Array<ArrayBuffer> =>
  encoder.encode(`ultimate.secrets|v=${header.v}|alg=${header.alg}|kid=${header.kid}`);

const importKey = (key: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * The plaintext form: one flat JSON object, keys sorted, two-space indent. Deterministic so
 * `x secrets edit` can compare the buffer it handed the editor against the one it got back and
 * skip the write when nothing changed — the ciphertext differs on every seal (the IV is fresh), so
 * without this every edit session would produce a diff whether or not a value moved.
 */
export function serializeSecretValues(values: SecretValues): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Flat, env-shaped and non-empty, or `X_SECRETS_PLAINTEXT_INVALID`. Runs before every seal. */
export function assertSecretValues(value: unknown, at: string): SecretValues {
  const refuse = (reason: string): never => {
    throw new SecretsPlaintextInvalidError({ at, reason });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('are not a JSON object');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!SECRET_NAME.test(key)) {
      return refuse(`name "${key}", which is not an environment variable name (A-Z, 0-9, _)`);
    }
    if (typeof entry !== 'string') return refuse(`give "${key}" a value that is not a string`);
    if (entry.length === 0) return refuse(`give "${key}" an empty value`);
  }
  return Object.freeze({ ...(value as Record<string, string>) });
}

/** The masked projection — names and lengths only. What `x secrets show` and any log may print. */
export interface SecretSummary {
  readonly name: string;
  readonly length: number;
}

export function describeSecrets(values: SecretValues): readonly SecretSummary[] {
  return Object.entries(values)
    .map(([name, value]) => ({ name, length: value.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Encrypt `values` under `keyHex` and return the exact bytes the committed file holds. */
export async function sealSecrets(
  values: SecretValues,
  keyHex: string,
  at: SecretsLocation,
): Promise<string> {
  const checked = assertSecretValues(values, at.file);
  const key = parseMasterKey(keyHex, at.key);
  const header = { v: SECRETS_VERSION, alg: SECRETS_ALG, kid: await masterKeyId(key) };
  const iv = crypto.getRandomValues(new Uint8Array(SECRETS_IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(header), tagLength: 128 },
    await importKey(key),
    encoder.encode(serializeSecretValues(checked)),
  );
  const envelope: SecretsEnvelope = {
    ...header,
    iv: encodeBase64(iv),
    ct: encodeBase64(new Uint8Array(sealed)),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function field(record: Record<string, unknown>, name: string, at: string, bytes?: number): string {
  const value = record[name];
  if (typeof value !== 'string' || !BASE64.test(value) || value.length === 0) {
    throw new SecretsFileInvalidError({ at, reason: `has no base64 "${name}" field` });
  }
  const decoded = decodeBase64(value);
  if (bytes !== undefined && decoded.length !== bytes) {
    throw new SecretsFileInvalidError({
      at,
      reason: `has a ${decoded.length}-byte "${name}"; AES-256-GCM uses ${bytes}`,
    });
  }
  return value;
}

/**
 * Read the envelope without needing a key. Every rejection here is `X_SECRETS_FILE_INVALID`: none
 * of it has reached authentication yet, so calling it tampering would send the reader hunting an
 * attacker for what is a truncated write or a merge conflict marker.
 */
export function parseSecretsEnvelope(text: string, at: string): SecretsEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretsFileInvalidError({ at, reason: 'is not JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SecretsFileInvalidError({ at, reason: 'is not a JSON object' });
  }
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== SECRETS_VERSION) {
    throw new SecretsFileInvalidError({
      at,
      reason: `declares envelope version ${JSON.stringify(record['v'])}; this build seals version ${SECRETS_VERSION}`,
    });
  }
  if (record['alg'] !== SECRETS_ALG) {
    throw new SecretsFileInvalidError({
      at,
      reason: `declares algorithm ${JSON.stringify(record['alg'])}; this build seals ${SECRETS_ALG}`,
    });
  }
  const kid = record['kid'];
  if (typeof kid !== 'string' || !KEY_ID.test(kid)) {
    throw new SecretsFileInvalidError({ at, reason: 'has no 16-character hex "kid" field' });
  }
  const iv = field(record, 'iv', at, SECRETS_IV_BYTES);
  const ct = field(record, 'ct', at);
  if (decodeBase64(ct).length <= SECRETS_TAG_BYTES) {
    throw new SecretsFileInvalidError({
      at,
      reason: `has a "ct" too short to hold a ${SECRETS_TAG_BYTES}-byte authentication tag and any content`,
    });
  }
  return { v: SECRETS_VERSION, alg: SECRETS_ALG, kid, iv, ct };
}

/**
 * Open a committed envelope. Four distinct refusals, in the order the facts become knowable: the
 * file is unreadable, the key is malformed, the key is the wrong one (the `kid` says so before any
 * decryption is attempted), or the tag rejected the body.
 */
export async function openSecrets(
  text: string,
  keyHex: string,
  at: SecretsLocation,
): Promise<SecretValues> {
  const envelope = parseSecretsEnvelope(text, at.file);
  const key = parseMasterKey(keyHex, at.key);
  const kid = await masterKeyId(key);
  if (kid !== envelope.kid) {
    throw new SecretsKeyMismatchError({
      at: at.file,
      keyAt: at.key,
      sealedWith: envelope.kid,
      found: kid,
    });
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64(envelope.iv),
        additionalData: additionalData(envelope),
        tagLength: 128,
      },
      await importKey(key),
      decodeBase64(envelope.ct),
    );
  } catch {
    // Deliberately no `sourceError`: WebCrypto's OperationError says nothing this code does not,
    // and an error that wraps a crypto exception is one more object a log could try to serialize.
    throw new SecretsTamperedError({ at: at.file });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new SecretsPlaintextInvalidError({ at: at.file, reason: 'are not JSON' });
  }
  return assertSecretValues(decoded, at.file);
}
