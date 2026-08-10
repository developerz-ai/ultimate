// Realtime's error codes render the same string in the terminal, the browser overlay and
// `--json` — the title registered here is that string's first line. This also guards the
// `RealtimeErrorCode` refactor from a bare union to an array-derived type: the member set must
// come out exactly as it went in, or a code silently disappears from `x errors explain`.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { REALTIME_ERROR_CODES, REALTIME_ERROR_TITLES } from './errors';

const ORIGINAL_MEMBERS = [
  'X_TOPIC_FORBIDDEN',
  'X_SUBSCRIPTION_LIMIT',
  'X_PROTOCOL_VERSION',
  'X_CURSOR_STALE',
  'X_REBASE_CONFLICT',
  'X_TRANSPORT_UNAVAILABLE',
  'X_TRANSPORT_PROTOCOL',
  'X_REPLICATION_PROTOCOL',
  'X_REPLICATION_FAILED',
  'X_NOT_IMPLEMENTED',
];

describe('REALTIME_ERROR_CODES', () => {
  test('has exactly the 10 members RealtimeErrorCode declared as a bare union before', () => {
    expect(REALTIME_ERROR_CODES.length).toBe(10);
    expect([...REALTIME_ERROR_CODES].sort()).toEqual([...ORIGINAL_MEMBERS].sort());
  });
});

describe('REALTIME_ERROR_TITLES', () => {
  test('has exactly one entry per code in REALTIME_ERROR_CODES, and no others', () => {
    expect(Object.keys(REALTIME_ERROR_TITLES).sort()).toEqual([...REALTIME_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of REALTIME_ERROR_CODES) {
      expect(typeof REALTIME_ERROR_TITLES[code]).toBe('string');
      expect(REALTIME_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every realtime code is registered with its declared title', () => {
    for (const code of REALTIME_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(REALTIME_ERROR_TITLES[code]);
    }
  });

  test('every realtime code documents at its own X_* url', () => {
    for (const code of REALTIME_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered with a realtime-owned title', () => {
    expect(hasErrorCode('X_NOT_IMPLEMENTED')).toBe(true);
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
    expect(REALTIME_ERROR_TITLES.X_NOT_IMPLEMENTED).toBe(
      describeErrorCode('X_NOT_IMPLEMENTED').title,
    );
  });
});
