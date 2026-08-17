// What a record is filed under. Two callers sending the same Idempotency-Key value must never
// meet in one record — the shipped key namespaced by action name alone, so bob replayed alice's
// stored response — and a blank header is not a key, it is every blank sender's shared key.

import { describe, expect, test } from 'bun:test';
import { anonymousActor, serviceActor, userActor } from '@ultimat3/core';
import { idempotencyKeyFor, MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency-key';

const alice = userActor({ id: 'alice' });
const bob = userActor({ id: 'bob' });

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('the namespaced idempotency key', () => {
  test("a second actor's identical key is a different record", () => {
    expect(idempotencyKeyFor('chargeCard', 'k1', alice)).not.toBe(
      idempotencyKeyFor('chargeCard', 'k1', bob),
    );
  });

  test('the same actor and the same key is the same record — the whole point of a retry', () => {
    expect(idempotencyKeyFor('chargeCard', 'k1', userActor({ id: 'alice' }))).toBe(
      idempotencyKeyFor('chargeCard', 'k1', alice),
    );
  });

  test('two actions still hold two key spaces', () => {
    expect(idempotencyKeyFor('chargeCard', 'k1', alice)).not.toBe(
      idempotencyKeyFor('refundCharge', 'k1', alice),
    );
  });

  test('an org is part of the identity, as it is everywhere else a caller is keyed', () => {
    expect(
      idempotencyKeyFor('chargeCard', 'k1', userActor({ id: 'alice', orgId: 'org-a' })),
    ).not.toBe(idempotencyKeyFor('chargeCard', 'k1', userActor({ id: 'alice', orgId: 'org-b' })));
  });

  test('two actor KINDS holding one id are two callers', () => {
    expect(idempotencyKeyFor('chargeCard', 'k1', userActor({ id: 'billing' }))).not.toBe(
      idempotencyKeyFor('chargeCard', 'k1', serviceActor({ id: 'billing' })),
    );
  });

  // Why the encoding is JSON and not a joined string, asserted as the property rather than as one
  // lucky pair: every part is recoverable verbatim, so no value a caller chooses can move a
  // boundary. Any `a:b:c` form fails this outright, and a form that survives one adversarial pair
  // still loses to the next — an actor id and a key are both app data.
  test('every part of the key is recoverable, which no joined string can promise', () => {
    const key = idempotencyKeyFor('chargeCard', 'x:y', userActor({ id: 'alice:x', orgId: 'o:1' }));

    expect(JSON.parse(key)).toEqual(['chargeCard', 'user', 'alice:x', 'o:1', 'x:y']);
  });

  // The pair the audit's own suggested shape — `${action}:${id}:${key}`, the join
  // `@ultimat3/jobs`' scheduler uses over values IT controls — collapses into one record.
  test('an actor id that spells the separator cannot reach another caller’s key', () => {
    expect(idempotencyKeyFor('chargeCard', 'x:y', userActor({ id: 'alice' }))).not.toBe(
      idempotencyKeyFor('chargeCard', 'y', userActor({ id: 'alice:x' })),
    );
  });

  // A documented LIMIT, pinned so it cannot become an accident: an anonymous caller has no
  // identity to narrow to, so every anonymous caller of a public idempotent action shares one key
  // space — exactly what they shared before this scoping existed. A key is caller-chosen, so a
  // UUID is what keeps them apart, and an action that must not be shared needs a policy.
  test('anonymous callers share one key space, because nothing here can tell them apart', () => {
    expect(idempotencyKeyFor('signUp', 'k1', anonymousActor())).toBe(
      idempotencyKeyFor('signUp', 'k1', anonymousActor()),
    );
  });
});

describe('a key that cannot identify one request is refused', () => {
  // `Headers.get()` answers `''` for `Idempotency-Key:` — not `null` — so an empty value used to
  // become a live key every blank sender shared. Absent is not the reading: a client that meant
  // to send a key and sent `undefined` would silently lose the protection and double-charge on
  // its own retry, which is the failure idempotency exists to prevent.
  test('an empty key is X_IDEMPOTENCY_KEY_INVALID, never treated as absent', () => {
    expect(codeOf(() => idempotencyKeyFor('chargeCard', '', alice))).toBe(
      'X_IDEMPOTENCY_KEY_INVALID',
    );
  });

  test('a whitespace-only key is refused for the same reason', () => {
    expect(codeOf(() => idempotencyKeyFor('chargeCard', '   ', alice))).toBe(
      'X_IDEMPOTENCY_KEY_INVALID',
    );
  });

  test('the published maxLength is enforced, so the spec and the runtime agree', () => {
    const longest = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(idempotencyKeyFor('chargeCard', longest, alice)).toContain(longest);
    expect(codeOf(() => idempotencyKeyFor('chargeCard', `${longest}k`, alice))).toBe(
      'X_IDEMPOTENCY_KEY_INVALID',
    );
  });

  test('the refusal says what to send, not only what was wrong', () => {
    let fix = '';
    try {
      idempotencyKeyFor('chargeCard', '', alice);
    } catch (error) {
      fix = (error as { fix?: string }).fix ?? '';
    }
    expect(fix).toContain('crypto.randomUUID()');
  });
});
