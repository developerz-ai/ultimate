import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { decodeRecordEnvelope, encodeRecordEnvelope } from './record-envelope';

function refusal(body: unknown): unknown {
  try {
    decodeRecordEnvelope(body);
  } catch (error) {
    return error;
  }
  return expect.unreachable('decodeRecordEnvelope accepted a malformed envelope');
}

describe('decodeRecordEnvelope', () => {
  test.each([
    ['a bare array', []],
    ['null', null],
    ['an object with no data member', { records: {} }],
    ['records that is not an object', { data: 1, records: [] }],
    [
      'a record group that is an array, not rows by key',
      { data: 1, records: { post: [{ id: 'p1' }] } },
    ],
    ['a record group that is not an object', { data: 1, records: { post: 'p1' } }],
    ['a row that is not an object', { data: 1, records: { post: { p1: 'p1' } } }],
    ['a removed group that is not an array', { data: 1, removed: { post: 'p0' } }],
    ['a removed key that is not a string', { data: 1, removed: { post: [7] } }],
    ['an order group that is not an array', { data: 1, order: { post: 'p0' } }],
    ['an order key that is not a string', { data: 1, order: { post: [30] } }],
  ])('refuses %s with X_CLIENT_RECORD_ENVELOPE_INVALID', (_label, body) => {
    const error = refusal(body);
    expect(isUltimateError(error) && error.code).toBe('X_CLIENT_RECORD_ENVELOPE_INVALID');
  });

  test('never renders the body it refused', () => {
    const error = refusal({ data: 1, records: { post: { p1: 'secret-token-value' } } });
    expect(isUltimateError(error) && error.cause).not.toContain('secret-token-value');
  });

  test('round-trips what encodeRecordEnvelope builds, through JSON', () => {
    const sent = encodeRecordEnvelope(
      { ok: true },
      { post: { p1: { id: 'p1' } } },
      { post: ['p0'] },
    );
    const got = decodeRecordEnvelope(JSON.parse(JSON.stringify(sent)));
    expect(got.data).toEqual({ ok: true });
    expect({ ...got.records }).toEqual({ post: { p1: { id: 'p1' } } });
    expect({ ...got.removed }).toEqual({ post: ['p0'] });
  });

  test('a data-only envelope decodes with no records and no removals', () => {
    expect(decodeRecordEnvelope({ data: null })).toEqual({ data: null });
  });

  test('a record type or key spelled __proto__ is a key, never a prototype', () => {
    const got = decodeRecordEnvelope(
      JSON.parse('{"data":1,"records":{"__proto__":{"__proto__":{"id":"x"}}}}'),
    );
    expect(Object.keys(got.records ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(got.records)).toBeNull();
    const rows = Object.values(got.records ?? {})[0];
    expect(Object.keys(rows ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(rows)).toBeNull();
  });
});

describe('encodeRecordEnvelope', () => {
  test('omits an empty removed map rather than claiming a deletion', () => {
    expect(encodeRecordEnvelope(1, { post: {} }, {})).toEqual({ data: 1, records: { post: {} } });
  });

  test("sends a type's order only where an object would lose it, and it survives JSON", () => {
    const posts = { '30': { id: 30 }, '4': { id: 4 } };
    const users = { u1: { id: 'u1' }, u2: { id: 'u2' } };
    const sent = encodeRecordEnvelope(null, { posts, users }, undefined, {
      posts: ['30', '4'],
      users: ['u1', 'u2'],
    });
    expect(sent.order).toEqual({ posts: ['30', '4'] });
    const got = decodeRecordEnvelope(JSON.parse(JSON.stringify(sent)));
    expect(Object.keys(got.records?.['posts'] ?? {})).toEqual(['4', '30']);
    expect({ ...got.order }).toEqual({ posts: ['30', '4'] });
  });

  test('an order every object already keeps is not sent: the wire stays byte-identical', () => {
    const records = { users: { u1: { id: 'u1' }, u2: { id: 'u2' } } };
    const ordered = encodeRecordEnvelope(1, records, undefined, { users: ['u1', 'u2'] });
    expect(JSON.stringify(ordered)).toBe(JSON.stringify(encodeRecordEnvelope(1, records)));
  });
});
