// The round trip is the cheap half. What earns these tests is everything that must NOT decrypt:
// the wrong key, a flipped byte, a truncated body, a downgraded header. An authenticated cipher
// that fails open is indistinguishable from one that works until the day it matters.

import { describe, expect, test } from 'bun:test';
import {
  assertSecretValues,
  describeSecrets,
  generateMasterKey,
  masterKeyId,
  openSecrets,
  parseMasterKey,
  parseSecretsEnvelope,
  SECRETS_ALG,
  SECRETS_KEY_HEX_LENGTH,
  SECRETS_VERSION,
  type SecretsEnvelope,
  sealSecrets,
  serializeSecretValues,
} from './secrets';

const AT = { file: 'secrets.enc.json', key: 'ULTIMATE_SECRETS_KEY' } as const;
const VALUES = { SESSION_SECRET: 'hunter2', STRIPE_KEY: 'sk_live_abc' } as const;

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

const envelopeOf = (text: string): SecretsEnvelope => JSON.parse(text) as SecretsEnvelope;
const reseal = (envelope: SecretsEnvelope): string => JSON.stringify(envelope);

/** Flip one bit in the middle of a base64 body — the smallest edit a tag must still catch. */
function flipByte(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return btoa(String.fromCharCode(...bytes));
}

describe('unit · master keys', () => {
  test('a generated key is 64 lowercase hex characters', () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key.length).toBe(SECRETS_KEY_HEX_LENGTH);
  });

  test('two generated keys differ — a constant key would pass every round-trip test here', () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  test('a truncated key is refused before anything is encrypted with it', () => {
    expect(() => parseMasterKey('a'.repeat(63), AT.key)).toThrow(/X_SECRETS_KEY_INVALID/);
  });

  test('a key with a non-hex character is refused, not silently parsed as NaN bytes', () => {
    expect(() => parseMasterKey(`${'a'.repeat(63)}z`, AT.key)).toThrow(/X_SECRETS_KEY_INVALID/);
  });

  test('surrounding whitespace is trimmed — the key file ends in a newline', () => {
    expect(parseMasterKey(`  ${KEY}\n`, AT.key)).toEqual(parseMasterKey(KEY, AT.key));
  });

  test('the key id is stable for one key and different for another', async () => {
    const mine = await masterKeyId(parseMasterKey(KEY, AT.key));
    expect(mine).toBe(await masterKeyId(parseMasterKey(KEY, AT.key)));
    expect(mine).not.toBe(await masterKeyId(parseMasterKey(OTHER_KEY, AT.key)));
    expect(mine).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the key id is not the key, nor any prefix of it', async () => {
    const id = await masterKeyId(parseMasterKey(KEY, AT.key));
    expect(KEY).not.toContain(id);
  });
});

describe('unit · the envelope', () => {
  test('a sealed file round-trips to the same values', async () => {
    const sealed = await sealSecrets(VALUES, KEY, AT);
    expect(await openSecrets(sealed, KEY, AT)).toEqual(VALUES);
  });

  test('the committed bytes carry no plaintext value', async () => {
    const sealed = await sealSecrets(VALUES, KEY, AT);
    expect(sealed).not.toContain('hunter2');
    expect(sealed).not.toContain('sk_live_abc');
    expect(sealed).not.toContain('SESSION_SECRET');
    expect(sealed).not.toContain(KEY);
  });

  test('the IV is fresh per seal, so the same values never produce the same file', async () => {
    const first = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const second = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
    expect(first.kid).toBe(second.kid);
  });

  test('the header is readable without a key — that is what makes a rotation reviewable', async () => {
    const envelope = parseSecretsEnvelope(await sealSecrets(VALUES, KEY, AT), AT.file);
    expect(envelope.v).toBe(SECRETS_VERSION);
    expect(envelope.alg).toBe(SECRETS_ALG);
    expect(envelope.kid).toBe(await masterKeyId(parseMasterKey(KEY, AT.key)));
  });

  test('an empty secrets map is a valid file — x secrets init writes one', async () => {
    const sealed = await sealSecrets({}, KEY, AT);
    expect(await openSecrets(sealed, KEY, AT)).toEqual({});
  });
});

describe('unit · what must not decrypt', () => {
  test('the WRONG key is X_SECRETS_KEY_MISMATCH, never a tag failure the reader has to guess at', async () => {
    const sealed = await sealSecrets(VALUES, KEY, AT);
    await expect(openSecrets(sealed, OTHER_KEY, AT)).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISMATCH',
    );
  });

  test('the mismatch names both key ids, so a rotation gone half-way is diagnosable', async () => {
    const sealed = await sealSecrets(VALUES, KEY, AT);
    const sealedWith = await masterKeyId(parseMasterKey(KEY, AT.key));
    const found = await masterKeyId(parseMasterKey(OTHER_KEY, AT.key));
    await expect(openSecrets(sealed, OTHER_KEY, AT)).rejects.toThrow(
      new RegExp(`${sealedWith}.*${found}`),
    );
  });

  test('a flipped byte in the ciphertext is X_SECRETS_TAMPERED, not silent garbage', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const edited = reseal({ ...envelope, ct: flipByte(envelope.ct) });
    await expect(openSecrets(edited, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_TAMPERED');
  });

  test('a flipped byte in the IV is X_SECRETS_TAMPERED — GCM authenticates under its nonce', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const edited = reseal({ ...envelope, iv: flipByte(envelope.iv) });
    await expect(openSecrets(edited, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_TAMPERED');
  });

  test('a truncated ciphertext is X_SECRETS_TAMPERED — the tag is what noticed', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const edited = reseal({ ...envelope, ct: envelope.ct.slice(0, envelope.ct.length - 4) });
    await expect(openSecrets(edited, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_TAMPERED');
  });

  test('a truncated FILE is X_SECRETS_FILE_INVALID — nothing reached authentication', async () => {
    const sealed = await sealSecrets(VALUES, KEY, AT);
    await expect(openSecrets(sealed.slice(0, 40), KEY, AT)).rejects.toBeUltimateError(
      'X_SECRETS_FILE_INVALID',
    );
  });

  // The reason the header is AAD and not decoration: a body sealed under one header must not open
  // under another. Without this a writer could renumber the envelope and change how it is read.
  test('a kid swapped to the opening key is X_SECRETS_TAMPERED — the header is authenticated', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const swapped = reseal({
      ...envelope,
      kid: await masterKeyId(parseMasterKey(OTHER_KEY, AT.key)),
    });
    await expect(openSecrets(swapped, OTHER_KEY, AT)).rejects.toBeUltimateError(
      'X_SECRETS_TAMPERED',
    );
  });

  test('a body from one file does not open inside a different header', async () => {
    const mine = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const theirs = envelopeOf(await sealSecrets({ OTHER: 'value' }, KEY, AT));
    const spliced = reseal({ ...mine, ct: theirs.ct });
    await expect(openSecrets(spliced, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_TAMPERED');
  });

  test('a downgraded alg is refused before a key is even parsed', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const edited = reseal({ ...envelope, alg: 'AES-256-CBC' });
    await expect(openSecrets(edited, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_FILE_INVALID');
  });

  test('an unknown envelope version is refused rather than read as version 1', () => {
    expect(() => parseSecretsEnvelope('{"v":2,"alg":"AES-256-GCM"}', AT.file)).toThrow(
      /X_SECRETS_FILE_INVALID/,
    );
  });

  test('a 16-byte IV is refused — AES-GCM is defined for a 12-byte nonce', async () => {
    const envelope = envelopeOf(await sealSecrets(VALUES, KEY, AT));
    const edited = reseal({ ...envelope, iv: btoa('0123456789abcdef') });
    await expect(openSecrets(edited, KEY, AT)).rejects.toBeUltimateError('X_SECRETS_FILE_INVALID');
  });

  test('a body that cannot hold a tag and content is refused', () => {
    const envelope = {
      v: 1,
      alg: SECRETS_ALG,
      kid: '0'.repeat(16),
      iv: btoa('123456789012'),
      ct: btoa('short'),
    };
    expect(() => parseSecretsEnvelope(JSON.stringify(envelope), AT.file)).toThrow(
      /X_SECRETS_FILE_INVALID/,
    );
  });

  test('a file that is not JSON at all is refused with the file named', () => {
    expect(() => parseSecretsEnvelope('<<<<<<< HEAD\n', AT.file)).toThrow(/X_SECRETS_FILE_INVALID/);
  });
});

describe('unit · the plaintext shape', () => {
  test('a nested object is refused — there is no second namespace under a secret name', () => {
    expect(() => assertSecretValues({ DB: { URL: 'x' } }, AT.file)).toThrow(
      /X_SECRETS_PLAINTEXT_INVALID/,
    );
  });

  test('a lowercase key is refused: the name IS the env var it becomes', () => {
    expect(() => assertSecretValues({ sessionSecret: 'x' }, AT.file)).toThrow(
      /X_SECRETS_PLAINTEXT_INVALID/,
    );
  });

  test('an empty value is refused — an empty env var reads as unset to defineEnv', () => {
    expect(() => assertSecretValues({ SESSION_SECRET: '' }, AT.file)).toThrow(
      /X_SECRETS_PLAINTEXT_INVALID/,
    );
  });

  test('an array is refused', () => {
    expect(() => assertSecretValues(['SESSION_SECRET'], AT.file)).toThrow(
      /X_SECRETS_PLAINTEXT_INVALID/,
    );
  });

  test('the refusal happens before sealing, so an unopenable file is never written', async () => {
    await expect(
      sealSecrets({ 'not an env name': 'x' } as never, KEY, AT),
    ).rejects.toBeUltimateError('X_SECRETS_PLAINTEXT_INVALID');
  });

  test('serialization is sorted and stable, so an unchanged edit produces no diff', () => {
    const one = serializeSecretValues({ B: '2', A: '1' });
    expect(one).toBe(serializeSecretValues({ A: '1', B: '2' }));
    // Both names survive the sort before either is ordered: a dropped key is `-1`, which is less
    // than every real offset, so "A comes first" would hold for a buffer that no longer carries A
    // at all — and this is the buffer `x secrets edit` seals.
    expect(one).toContain('"A": "1"');
    expect(one.indexOf('"A"')).toBeLessThan(one.indexOf('"B"'));
  });

  test('the masked projection carries names and lengths, never a value', () => {
    expect(describeSecrets(VALUES)).toEqual([
      { name: 'SESSION_SECRET', length: 7 },
      { name: 'STRIPE_KEY', length: 11 },
    ]);
  });
});
