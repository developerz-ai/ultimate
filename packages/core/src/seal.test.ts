// `seal()` / `open()` against real WebCrypto and real keys. What every assertion guards is one
// rule: a sealed value either opens to exactly what was sealed, under the purpose it was sealed
// for, or it is refused with a code — never garbage, never the raw string handed back.

import { describe, expect, test } from 'bun:test';
import { classifyThrown, declaredErrorRetry } from './error-retry';
import { isUltimateError } from './errors';
import { isSealed, open, openText, seal, sealAll, sealedKeyId } from './seal';
import { resolveSealKeys, SECRETS_RETIRED_KEYS_ENV, sealKeyIds } from './seal-keys';
import { generateMasterKey, masterKeyId, parseMasterKey } from './secrets';
import { SECRETS_KEY_ENV } from './secrets-store';

/** A root with no `.secrets.key`, so the injected `env` is the only place a key can come from. */
const ROOT = '/nonexistent/ultimate-seal-test';
const PURPOSE = 'entity:connections.password';

const keyed = (current: string, retired: readonly string[] = []) => ({
  root: ROOT,
  env: {
    [SECRETS_KEY_ENV]: current,
    ...(retired.length === 0 ? {} : { [SECRETS_RETIRED_KEYS_ENV]: retired.join(',') }),
  },
});

const idOf = (hex: string): Promise<string> => masterKeyId(parseMasterKey(hex, 'test'));

async function refusal(run: () => Promise<unknown>): Promise<{
  code: string;
  cause: string;
  fix: string;
  retry: string;
  meta: Readonly<Record<string, unknown>>;
}> {
  try {
    await run();
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    return {
      code: error.code,
      cause: String(error.cause),
      fix: error.fix,
      retry: error.retry,
      meta: error.meta ?? {},
    };
  }
  return expect.unreachable('the call was expected to refuse');
}

/** Flip one bit of one base64url character in the named dot-separated part. */
function flip(sealed: string, part: number): string {
  const parts = sealed.split('.');
  const target = parts[part] ?? '';
  const swapped = target.startsWith('A') ? `B${target.slice(1)}` : `A${target.slice(1)}`;
  parts[part] = swapped;
  return parts.join('.');
}

describe('unit · seal round trip', () => {
  const key = generateMasterKey();
  const keys = keyed(key);

  test('a string seals to x1.<keyId>.<iv>.<ciphertext> and opens to itself', async () => {
    const sealed = await seal('hunter2 — ünïcode', { purpose: PURPOSE, ...keys });
    expect(sealed).toMatch(/^x1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed.split('.')[1]).toBe(await idOf(key));
    expect(sealed).not.toContain('hunter2');
    expect(await openText(sealed, { purpose: PURPOSE, ...keys })).toBe('hunter2 — ünïcode');
  });

  test('bytes seal and open as bytes, the empty value included', async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 2]);
    const sealed = await seal(bytes, { purpose: PURPOSE, ...keys });
    expect([...(await open(sealed, { purpose: PURPOSE, ...keys }))]).toEqual([...bytes]);
    const empty = await seal('', { purpose: PURPOSE, ...keys });
    expect(await openText(empty, { purpose: PURPOSE, ...keys })).toBe('');
  });

  test('two seals of one value differ — the IV is fresh', async () => {
    const first = await seal('same', { purpose: PURPOSE, ...keys });
    const second = await seal('same', { purpose: PURPOSE, ...keys });
    expect(first).not.toBe(second);
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
  });

  test('isSealed and sealedKeyId read the shape without a key', async () => {
    const sealed = await seal('v', { purpose: PURPOSE, ...keys });
    expect(isSealed(sealed)).toBe(true);
    expect(sealedKeyId(sealed)).toBe(await idOf(key));
    expect(isSealed('plain legacy value')).toBe(false);
    expect(isSealed(`x2.${sealed.slice(3)}`)).toBe(false);
    expect(isSealed(42)).toBe(false);
  });
});

describe('unit · seal refusals', () => {
  const key = generateMasterKey();
  const keys = keyed(key);

  test('a wrong purpose is X_SEAL_INVALID naming the key and both readings', async () => {
    const sealed = await seal('token', { purpose: 'scrape-session', ...keys });
    const refused = await refusal(() => open(sealed, { purpose: PURPOSE, ...keys }));
    expect(refused.code).toBe('X_SEAL_INVALID');
    expect(refused.cause).toContain(await idOf(key));
    expect(refused.cause).toContain(PURPOSE);
    expect(refused.cause).toContain('purpose');
    expect(refused.cause).toContain('changed');
    expect(refused.fix).toStartWith('x secrets show');
    expect(refused.retry).toBe('terminal');
  });

  test('one flipped byte is refused, in the ciphertext and in the IV', async () => {
    const sealed = await seal('token', { purpose: PURPOSE, ...keys });
    for (const part of [2, 3]) {
      const refused = await refusal(() => open(flip(sealed, part), { purpose: PURPOSE, ...keys }));
      expect(refused.code).toBe('X_SEAL_INVALID');
    }
  });

  test('a string that is not a sealed value is refused, never returned', async () => {
    for (const value of ['plain legacy value', '', 'x1.short.aa.bb', 'x1.0123456789abcdef.a.b']) {
      const refused = await refusal(() => openText(value, { purpose: PURPOSE, ...keys }));
      expect(refused.code).toBe('X_SEAL_INVALID');
      expect(refused.cause).toContain('x1.<keyId>.<iv>.<ciphertext>');
      // Not the key's problem: the repair is a migration, and the fix says which one.
      expect(refused.fix).toContain('backfill()');
      // The value is described, never echoed: a legacy plaintext must not land in a log.
      if (value.length > 0) expect(refused.cause).not.toContain(value);
    }
    expect(() => sealedKeyId('plain')).toThrow(/X_SEAL_INVALID/);
  });

  test('no master key is X_SEAL_KEY_MISSING and names the fix', async () => {
    const none = { root: ROOT, env: {} };
    const sealing = await refusal(() => seal('v', { purpose: PURPOSE, ...none }));
    expect(sealing.code).toBe('X_SEAL_KEY_MISSING');
    expect(sealing.fix).toStartWith('x secrets init');
    expect(sealing.cause).toContain(SECRETS_KEY_ENV);
    expect(sealing.retry).toBe('terminal');
    const sealed = await seal('v', { purpose: PURPOSE, ...keys });
    expect((await refusal(() => open(sealed, { purpose: PURPOSE, ...none }))).code).toBe(
      'X_SEAL_KEY_MISSING',
    );
  });

  test('a body no whole number of bytes encodes to is malformed, not an authentication failure', async () => {
    const sealed = await seal('token', { purpose: PURPOSE, ...keys });
    // 5 plaintext bytes + a 16-byte tag are 28 characters; 29 is a length base64 never produces.
    const refused = await refusal(() => open(`${sealed}A`, { purpose: PURPOSE, ...keys }));
    expect(refused.meta['reason']).toBe('malformed');
    expect(isSealed(`${sealed}A`)).toBe(false);
  });

  test('all three codes are DECLARED terminal, so a job stops instead of retrying', async () => {
    for (const code of ['X_SEAL_INVALID', 'X_SEAL_KEY_MISSING', 'X_SEAL_KEY_UNKNOWN']) {
      expect(declaredErrorRetry(code)).toBe('terminal');
    }
    const thrown = await seal('v', { purpose: PURPOSE, root: ROOT, env: {} }).catch(
      (error: unknown) => error,
    );
    expect(classifyThrown(thrown)).toBe('terminal');
  });

  test('openText refuses bytes that are not text, with a code and the call to make', async () => {
    const sealed = await seal(new Uint8Array([0xff, 0xfe]), { purpose: PURPOSE, ...keys });
    const refused = await refusal(() => openText(sealed, { purpose: PURPOSE, ...keys }));
    expect(refused.code).toBe('X_INVARIANT');
    expect(refused.fix).toContain('open()');
  });

  test('an empty purpose is refused before any key is read', async () => {
    const refused = await refusal(() => seal('v', { purpose: '', root: ROOT, env: {} }));
    expect(refused.code).toBe('X_INVARIANT');
    expect(refused.fix).toContain('purpose:');
  });

  test('a malformed master key is the existing X_SECRETS_KEY_INVALID', async () => {
    const refused = await refusal(() => seal('v', { purpose: PURPOSE, ...keyed('abc') }));
    expect(refused.code).toBe('X_SECRETS_KEY_INVALID');
    // The shipped line for the current key, unchanged.
    expect(refused.fix).toStartWith(`export ${SECRETS_KEY_ENV}="$(cat .secrets.key)"`);
  });
});

describe('unit · seal key ring', () => {
  const retired = generateMasterKey();
  const current = generateMasterKey();

  test('a value sealed under a retired key opens while that key is declared', async () => {
    const old = await seal('carried', { purpose: PURPOSE, ...keyed(retired) });
    const ring = keyed(current, [retired]);
    expect(await openText(old, { purpose: PURPOSE, ...ring })).toBe('carried');
    // And a new seal is always under the CURRENT key.
    expect(sealedKeyId(await seal('carried', { purpose: PURPOSE, ...ring }))).toBe(
      await idOf(current),
    );
    expect(await sealKeyIds(ring)).toEqual({
      current: await idOf(current),
      retired: [await idOf(retired)],
    });
  });

  test('…and refuses with X_SEAL_KEY_UNKNOWN once it is not, listing the declared ids', async () => {
    const old = await seal('carried', { purpose: PURPOSE, ...keyed(retired) });
    const other = generateMasterKey();
    const refused = await refusal(() =>
      open(old, { purpose: PURPOSE, ...keyed(current, [other]) }),
    );
    expect(refused.code).toBe('X_SEAL_KEY_UNKNOWN');
    expect(refused.cause).toContain(await idOf(retired));
    expect(refused.cause).toContain(await idOf(current));
    expect(refused.cause).toContain(await idOf(other));
    expect(refused.fix).toContain(SECRETS_RETIRED_KEYS_ENV);
    expect(refused.retry).toBe('terminal');
    expect(refused.meta['declared']).toEqual([await idOf(current), await idOf(other)]);
  });

  test('the ring tolerates whitespace, newlines and a repeat of the current key', async () => {
    const env = {
      [SECRETS_KEY_ENV]: current,
      [SECRETS_RETIRED_KEYS_ENV]: ` ${retired},\n${current} , ${retired}\n`,
    };
    expect(await sealKeyIds({ root: ROOT, env })).toEqual({
      current: await idOf(current),
      retired: [await idOf(retired)],
    });
  });

  test('a malformed retired key is refused by name, never skipped', async () => {
    const env = { [SECRETS_KEY_ENV]: current, [SECRETS_RETIRED_KEYS_ENV]: `${retired},nothex` };
    const refused = await refusal(() => sealKeyIds({ root: ROOT, env }));
    expect(refused.code).toBe('X_SECRETS_KEY_INVALID');
    expect(refused.cause).toContain(`${SECRETS_RETIRED_KEYS_ENV} (entry 2)`);
    // The fix names the variable that is wrong — never the current key's, which is fine.
    expect(refused.fix).toStartWith('x secrets edit');
    expect(refused.fix).toContain(SECRETS_RETIRED_KEYS_ENV);
    expect(refused.fix).not.toContain(`${SECRETS_KEY_ENV}=`);
  });

  test('a ring resolved once seals and opens many values without finding the key again', async () => {
    const ring = await resolveSealKeys(keyed(current, [retired]));
    // No key anywhere the call could find one: the ring it was handed is the only source.
    const none = { root: ROOT, env: {}, keys: ring };
    const sealed = await seal('batched', { purpose: PURPOSE, ...none });
    expect(sealedKeyId(sealed)).toBe(await idOf(current));
    expect(await openText(sealed, { purpose: PURPOSE, ...none })).toBe('batched');
    expect(await sealAll('batched', { purpose: PURPOSE, ...none })).toHaveLength(2);
    const old = await seal('carried', { purpose: PURPOSE, ...keyed(retired) });
    expect(await openText(old, { purpose: PURPOSE, ...none })).toBe('carried');
  });

  test('a changed environment is a changed ring — nothing is cached past its source', async () => {
    const sealed = await seal('v', { purpose: PURPOSE, ...keyed(retired) });
    expect(await openText(sealed, { purpose: PURPOSE, ...keyed(current, [retired]) })).toBe('v');
    const dropped = await refusal(() => open(sealed, { purpose: PURPOSE, ...keyed(current) }));
    expect(dropped.code).toBe('X_SEAL_KEY_UNKNOWN');
  });
});

describe('unit · deterministic seal', () => {
  const retired = generateMasterKey();
  const current = generateMasterKey();
  const keys = keyed(current);

  test('equal values seal equal, different values differ, and both open', async () => {
    const options = { purpose: PURPOSE, deterministic: true, ...keys };
    const first = await seal('alice@example.com', options);
    expect(await seal('alice@example.com', options)).toBe(first);
    expect(await seal('bob@example.com', options)).not.toBe(first);
    expect(await openText(first, { purpose: PURPOSE, ...keys })).toBe('alice@example.com');
  });

  // A PERSISTED format: these bytes are in somebody's table. A change to the AAD string, the IV
  // derivation, the MAC label or the alphabet moves this vector, and that change is `x2`.
  test('the wire form is pinned by a known answer', async () => {
    const fixed = keyed('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const vector =
      'x1.03dce9a066b23a2f.j3hKik0-dwTEcKVn.uJT-xI5nVvd9NQcySeKJUBMHyUnwOooahvJdGpvRRkO0';
    const options = { purpose: 'entity:users.email', ...fixed };
    expect(await seal('alice@example.com', { ...options, deterministic: true })).toBe(vector);
    expect(await openText(vector, options)).toBe('alice@example.com');
  });

  test('the purpose is in the IV: one value under two purposes shares nothing', async () => {
    const a = await seal('v', { purpose: 'a', deterministic: true, ...keys });
    const b = await seal('v', { purpose: 'b', deterministic: true, ...keys });
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    // The length prefix keeps (purpose, value) pairs apart where concatenation would collide.
    const joined = await seal('bc', { purpose: 'a', deterministic: true, ...keys });
    const split = await seal('c', { purpose: 'ab', deterministic: true, ...keys });
    expect(joined.split('.')[2]).not.toBe(split.split('.')[2]);
  });

  test('sealAll returns one candidate per declared key, current first', async () => {
    const ring = keyed(current, [retired]);
    const candidates = await sealAll('alice@example.com', { purpose: PURPOSE, ...ring });
    expect(candidates.map(sealedKeyId)).toEqual([await idOf(current), await idOf(retired)]);
    expect(candidates[0]).toBe(
      await seal('alice@example.com', { purpose: PURPOSE, deterministic: true, ...ring }),
    );
    // The row written before the rotation is the second candidate, byte for byte.
    expect(candidates[1]).toBe(
      await seal('alice@example.com', {
        purpose: PURPOSE,
        deterministic: true,
        ...keyed(retired),
      }),
    );
  });
});
