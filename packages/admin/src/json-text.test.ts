import { describe, expect, test } from 'bun:test';
import { jsonText, valueText } from './json-text';

describe('unit · jsonText is what an operator reads', () => {
  test('a bigint is its digits — never `BigInt(2)`, and never a throw', () => {
    expect(jsonText({ b: 1, a: 2n })).toBe('{"a":2,"b":1}');
    expect(jsonText(9007199254740993n)).toBe('9007199254740993');
  });

  test('keys are sorted at every depth, so two equal values read alike', () => {
    expect(jsonText({ z: { b: 1, a: [{ d: 1, c: 2 }] }, a: null })).toBe(
      '{"a":null,"z":{"a":[{"c":2,"d":1}],"b":1}}',
    );
  });

  test('an instant is ISO text; an invalid one, a function and a non-finite number are null', () => {
    expect(jsonText(new Date('2026-01-02T03:04:05.000Z'))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(jsonText([new Date(Number.NaN), () => 1, Number.NaN, Symbol('x')])).toBe(
      '[null,null,null,null]',
    );
    expect(jsonText({ kept: true, dropped: undefined })).toBe('{"kept":true}');
  });

  test('a Map reads as an object and a Set as a list', () => {
    expect(
      jsonText(
        new Map([
          ['b', 1],
          ['a', 2],
        ]),
      ),
    ).toBe('{"a":2,"b":1}');
    expect(jsonText(new Set(['x', 'y']))).toBe('["x","y"]');
  });

  test('a cycle is cut where it closes, and a shared value is not mistaken for one', () => {
    const loop: Record<string, unknown> = { name: 'a' };
    loop['self'] = loop;
    expect(jsonText(loop)).toBe('{"name":"a","self":"[circular]"}');
    const shared = { n: 1 };
    expect(jsonText([shared, shared])).toBe('[{"n":1},{"n":1}]');
  });

  test('valueText keeps text as text and renders everything else', () => {
    expect(valueText('draft')).toBe('draft');
    expect(valueText(null)).toBe('');
    expect(valueText(undefined)).toBe('');
    expect(valueText({ minor: 1200n, currency: 'EUR' })).toBe('{"currency":"EUR","minor":1200}');
    expect(valueText(false)).toBe('false');
  });
});
