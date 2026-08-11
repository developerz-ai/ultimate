// Realtime's error codes render the same string in the terminal, the browser overlay and
// `--json` — the title registered here is that string's first line. This also guards the
// `RealtimeErrorCode` refactor from a bare union to an array-derived type: the member set must
// come out exactly as it went in, or a code silently disappears from `x errors explain`.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  REALTIME_BORROWED_ERROR_CODES,
  REALTIME_ERROR_CODES,
  REALTIME_ERROR_TITLES,
  REALTIME_OWNED_ERROR_CODES,
} from './errors';

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

/** Codes added since the refactor. A shipped code is forever, so this list only ever grows. */
const ADDED_SINCE = ['X_LIVE_CLIENT_MISSING', 'X_REPLICATOR_SLOT_HELD', 'X_LIVE_ROW_UNIDENTIFIED'];

/** Widened once: these lists are compared against plain strings, not against the literal union. */
const EVERY_CODE: readonly string[] = REALTIME_ERROR_CODES;
const OWNED_CODES: readonly string[] = REALTIME_OWNED_ERROR_CODES;
const BORROWED_CODES: readonly string[] = REALTIME_BORROWED_ERROR_CODES;

describe('REALTIME_ERROR_CODES', () => {
  test('still carries every member RealtimeErrorCode declared as a bare union before', () => {
    for (const code of ORIGINAL_MEMBERS) expect(EVERY_CODE).toContain(code);
  });

  test('is exactly the original members plus the ones added since', () => {
    expect(REALTIME_ERROR_CODES.length).toBe(ORIGINAL_MEMBERS.length + ADDED_SINCE.length);
    expect([...EVERY_CODE].sort()).toEqual([...ORIGINAL_MEMBERS, ...ADDED_SINCE].sort());
  });

  test('owned and borrowed are disjoint and together are every code realtime throws', () => {
    const owned = new Set(OWNED_CODES);
    for (const code of BORROWED_CODES) expect(owned.has(code)).toBe(false);
    expect([...EVERY_CODE].sort()).toEqual([...OWNED_CODES, ...BORROWED_CODES].sort());
  });
});

describe('REALTIME_ERROR_TITLES', () => {
  test('titles exactly the codes realtime owns — a borrowed code carries no title here', () => {
    expect(Object.keys(REALTIME_ERROR_TITLES).sort()).toEqual(
      [...REALTIME_OWNED_ERROR_CODES].sort(),
    );
  });

  test('every title is a non-empty string', () => {
    for (const code of REALTIME_OWNED_ERROR_CODES) {
      expect(typeof REALTIME_ERROR_TITLES[code]).toBe('string');
      expect(REALTIME_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every realtime-owned code is registered with its declared title', () => {
    for (const code of REALTIME_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(REALTIME_ERROR_TITLES[code]);
    }
  });

  test('every realtime code documents at its own X_* url', () => {
    for (const code of REALTIME_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, read through the registry not through realtime', () => {
    expect(hasErrorCode('X_NOT_IMPLEMENTED')).toBe(true);
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
    expect(Object.keys(REALTIME_ERROR_TITLES)).not.toContain('X_NOT_IMPLEMENTED');
  });
});
