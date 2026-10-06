// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures below are SOURCE TEXT — a
// literal ${…} inside a string is the interpolation under test.
// The shapes `scripts/secret-compare.ts` learned in plan 101 sweep 11, split from
// `secret-compare.test.ts` at its size ceiling: two byte loops it did not read, and a template's
// interpolations, which it read as a constant.

import { describe, expect, test } from 'bun:test';
import { scanSecretCompares } from './secret-compare';

const names = (source: string): readonly string[] =>
  scanSecretCompares('packages/auth/src/a.ts', source).map((site) => site.name);
const kinds = (source: string): readonly string[] =>
  scanSecretCompares('packages/x/src/a.ts', source).map((site) => site.kind);

describe('the byte loops beside deepEquals', () => {
  test('a.equals(b) stops at the first differing byte, on either side', () => {
    expect(kinds('const ok = presented.equals(record.tokenHash);')).toEqual(['buffer-equal']);
    expect(kinds('const ok = expectedMac.equals(given);')).toEqual(['buffer-equal']);
    expect(kinds('const ok = left.equals(right);')).toEqual([]);
    expect(kinds('const ok = signature.equals(null);')).toEqual([]);
  });

  test('Buffer.compare(a, b) is a byte-order walk, read on every argument', () => {
    expect(kinds('if (Buffer.compare(mac, expectedMac) !== 0) throw x();')).toEqual([
      'buffer-equal',
    ]);
    expect(kinds('const order = Buffer.compare(left, right);')).toEqual([]);
  });
});

// Sweep 11 R4: a template literal's opening backtick made the whole operand inert, so a value
// computed at run time inside `${…}` read as a constant and the comparison vanished.
describe('a template that interpolates is a value, not a constant', () => {
  test('the brief’s own slip: a webhook signature against an interpolated digest', () => {
    expect(names('if (sig === `sha256=${hmac(body)}`) return true;')).toEqual(['sig']);
  });

  test('a secret named only INSIDE the interpolation is read', () => {
    expect(names('if (header === `Bearer ${session.apiToken}`) return;')).toEqual(['apiToken']);
    expect(names('const ok = given.startsWith(`${csrfToken}.`);')).toEqual(['csrfToken']);
  });

  test('a template with nothing interpolated is still a constant, and its static text is not code', () => {
    expect(names('if (token === `literal`) return;')).toEqual([]);
    expect(names('const s = `if (tokenHash === ${stored}) return;`;')).toEqual([]);
    expect(names('if (state === `${prefix}`.length) return;')).toEqual([]);
  });

  test('a string inside an interpolation stays masked', () => {
    expect(names("const s = `${f('a === token')}`;")).toEqual([]);
  });
});
