// Realtime's error codes render the same string in the terminal, the browser overlay and
// `--json` — the title registered here is that string's first line. This also guards the
// `RealtimeErrorCode` refactor from a bare union to an array-derived type: the member set must
// come out exactly as it went in, or a code silently disappears from `x errors explain`.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  isClientFault,
  isPolicyDenial,
  LiveQueryUnknownError,
  POLICY_DENIAL_CODES,
  REALTIME_BORROWED_ERROR_CODES,
  REALTIME_CLIENT_FAULT_CODES,
  REALTIME_ERROR_CODES,
  REALTIME_ERROR_TITLES,
  REALTIME_OWNED_ERROR_CODES,
  TopicForbiddenError,
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
const ADDED_SINCE = [
  'X_LIVE_CLIENT_MISSING',
  'X_REPLICATOR_SLOT_HELD',
  'X_LIVE_ROW_UNIDENTIFIED',
  'X_QUERY_NOT_SUBSCRIBABLE',
  'X_LIVE_QUERY_UNKNOWN',
  'X_SUBSCRIPTION_ID_TAKEN',
  'X_SOCKET_UNAUTHENTICATED',
  'X_SOCKET_AUTH_UNAVAILABLE',
  'X_FRAME_RATE_LIMIT',
  'X_LIVE_REPLICA_IDENTITY',
];

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

/**
 * The sync protocol has no status codes, so this set is the only thing standing between an error
 * monitor and every denied subscribe on the internet.
 */
describe('isClientFault', () => {
  test('a denied topic, a cap and a skewed protocol are the client’s, not the node’s', () => {
    expect(isClientFault(new TopicForbiddenError({ topic: 'org:1', actorId: 'u_1' }))).toBe(true);
    expect(isClientFault({ code: 'X_SUBSCRIPTION_LIMIT' })).toBe(true);
    expect(isClientFault({ code: 'X_PROTOCOL_VERSION' })).toBe(true);
    // A name this node never registered is the client's typo, not this node's outage.
    expect(isClientFault(new LiveQueryUnknownError({ name: 'liveFed' }))).toBe(true);
    // Borrowed from policy/auth: a surface denial is still the caller's condition.
    expect(isClientFault({ code: 'X_FORBIDDEN' })).toBe(true);
  });

  test('an unreachable bus and an accidental TypeError are this node’s fault', () => {
    expect(isClientFault({ code: 'X_TRANSPORT_UNAVAILABLE' })).toBe(false);
    expect(isClientFault(new TypeError('undefined is not a function'))).toBe(false);
    expect(isClientFault('a string nobody typed')).toBe(false);
  });

  test('every client-fault code is one this package or a sibling actually declares', () => {
    const known = new Set<string>([...REALTIME_ERROR_CODES, 'X_FORBIDDEN', 'X_UNAUTHENTICATED']);
    for (const code of REALTIME_CLIENT_FAULT_CODES) {
      expect(known.has(code), `${code} is in the client-fault set but nothing declares it`).toBe(
        true,
      );
    }
  });
});

/**
 * The narrower question the live gates ask: not "whose fault is this" but "was this a decision at
 * all". A cap and a stale cursor are the client's fault and still not denials — reading one as a
 * denial is how a subscription gets destroyed for a reason nobody chose.
 */
describe('isPolicyDenial', () => {
  test('only the two authz codes are decisions', () => {
    expect(isPolicyDenial({ code: 'X_FORBIDDEN' })).toBe(true);
    expect(isPolicyDenial({ code: 'X_UNAUTHENTICATED' })).toBe(true);
  });

  test('a client fault that is not an authz answer is still not a denial', () => {
    expect(isPolicyDenial(new TopicForbiddenError({ topic: 'org:1', actorId: 'u_1' }))).toBe(false);
    expect(isPolicyDenial({ code: 'X_SUBSCRIPTION_LIMIT' })).toBe(false);
    expect(isPolicyDenial({ code: 'X_CURSOR_STALE' })).toBe(false);
  });

  test('a timeout, a TypeError and a bare string never decided anything', () => {
    expect(isPolicyDenial({ code: 'X_DB_TIMEOUT' })).toBe(false);
    expect(isPolicyDenial(new TypeError('undefined is not a function'))).toBe(false);
    expect(isPolicyDenial('a string nobody typed')).toBe(false);
    expect(isPolicyDenial({ code: 42 })).toBe(false);
  });

  test('every denial code is a client fault — the sets are declared together, not copied', () => {
    for (const code of POLICY_DENIAL_CODES) {
      expect(REALTIME_CLIENT_FAULT_CODES.has(code), `${code} must be a client fault`).toBe(true);
    }
  });
});
