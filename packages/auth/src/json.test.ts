// Pins the two facts the six former copies of `isRecord` and the three former copies of the JWT
// payload decode all depended on and none of them stated: an array is not a record, and an
// undecodable segment is `null` rather than an exception escaping a coded path.

import { describe, expect, test } from 'bun:test';
import { decodeJwtSegment, isRecord } from './json';

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('isRecord', () => {
  test('an array is not a record', () => {
    // The variant that omits this check is the one five other packages carry. On a decoded JWT
    // payload it is the difference between refusing `[]` and reading claims off it.
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ iss: 'https://issuer.test' }])).toBe(false);
  });

  test('an object is, and nothing else is', () => {
    expect(isRecord({ iss: 'https://issuer.test' })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('{}')).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('decodeJwtSegment', () => {
  test('a base64url JSON object decodes to that object', () => {
    expect(decodeJwtSegment(segment({ iss: 'https://issuer.test', exp: 1 }))).toEqual({
      iss: 'https://issuer.test',
      exp: 1,
    });
  });

  test('every way a segment can fail to be an object answers null, and none throws', () => {
    expect(decodeJwtSegment('!!!not base64url!!!')).toBeNull();
    expect(decodeJwtSegment(Buffer.from('{ not json').toString('base64url'))).toBeNull();
    expect(decodeJwtSegment(segment([1, 2]))).toBeNull();
    expect(decodeJwtSegment(segment('a string'))).toBeNull();
    expect(decodeJwtSegment(segment(null))).toBeNull();
    expect(decodeJwtSegment('')).toBeNull();
  });
});
