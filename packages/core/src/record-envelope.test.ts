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
});
