import { afterEach, describe, expect, test } from 'bun:test';
import { fingerprint } from './canonical-json';
import { configureCursorSigning, resetCursorSigning } from './cursor';
import { compareFingerprint, keyedFingerprint } from './keyed-fingerprint';

const INPUT = { accountNumber: '0123456789', bank: 'bancolombia' };
const PURPOSE = 'test.purpose';

afterEach(() => resetCursorSigning());

describe('keyedFingerprint', () => {
  test('is versioned, stable for one input, and different for another', () => {
    configureCursorSigning('secret-a');
    const first = keyedFingerprint(INPUT, PURPOSE);
    expect(first).toMatch(/^h1:[0-9a-f]{8}:[0-9a-f]{32}$/);
    expect(keyedFingerprint({ bank: 'bancolombia', accountNumber: '0123456789' }, PURPOSE)).toBe(
      first,
    );
    expect(keyedFingerprint({ ...INPUT, accountNumber: '0123456780' }, PURPOSE)).not.toBe(first);
  });

  test('cannot be reproduced without the secret: no bare SHA-256 of the input appears in it', () => {
    configureCursorSigning('secret-a');
    const keyed = keyedFingerprint(INPUT, PURPOSE);
    const bare = fingerprint(INPUT);
    const fullBare = new Bun.CryptoHasher('sha256').update(JSON.stringify(INPUT)).digest('hex');
    expect(keyed).not.toContain(bare);
    expect(keyed).not.toContain(fullBare.slice(0, 32));
    configureCursorSigning('secret-b');
    expect(keyedFingerprint(INPUT, PURPOSE)).not.toBe(keyed);
  });

  test('two purposes never share a key', () => {
    configureCursorSigning('secret-a');
    expect(keyedFingerprint(INPUT, 'one')).not.toBe(keyedFingerprint(INPUT, 'two'));
  });
});

describe('compareFingerprint', () => {
  test('matches its own input and refuses another', () => {
    configureCursorSigning('secret-a');
    const stored = keyedFingerprint(INPUT, PURPOSE);
    expect(compareFingerprint(stored, INPUT, PURPOSE)).toBe('match');
    expect(compareFingerprint(stored, { ...INPUT, bank: 'x' }, PURPOSE)).toBe('mismatch');
  });

  test('a legacy unkeyed value is still checked exactly', () => {
    configureCursorSigning('secret-a');
    const legacy = fingerprint(INPUT);
    expect(compareFingerprint(legacy, INPUT, PURPOSE)).toBe('match');
    expect(compareFingerprint(legacy, { ...INPUT, bank: 'x' }, PURPOSE)).toBe('mismatch');
  });

  test('a value keyed under another secret is unverifiable, not a mismatch', () => {
    configureCursorSigning('secret-a');
    const stored = keyedFingerprint(INPUT, PURPOSE);
    configureCursorSigning('secret-b');
    expect(compareFingerprint(stored, INPUT, PURPOSE)).toBe('unverifiable');
    expect(compareFingerprint('h9:whatever', INPUT, PURPOSE)).toBe('unverifiable');
  });
});
