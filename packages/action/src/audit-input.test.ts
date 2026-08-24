/**
 * What may be written down. An `AuditRecord.input` is the PARSED input, which is exactly where a
 * password, a bearer token or a card number lives — and a durable sink turns "the framework saw
 * it" into "the framework stored it". Two rules, and neither is optional:
 *
 *  1. A key core's logger redacts is redacted here. One table, so a value that is `[redacted]` in
 *     a log line cannot be plaintext in an audit table.
 *  2. The answer is always JSON-representable, so a sink can never throw ON the caller's input —
 *     `auditSettled` turns a sink throw into a failed invocation for a handler that has committed.
 */

import { describe, expect, test } from 'bun:test';
import { REDACTED, redactKeys, secret } from '@ultimat3/core';
import { AUDIT_INPUT_MAX_DEPTH, auditableInput, UNREPRESENTABLE } from './audit-input';

// The ONE assertion that can tell "reads core's redaction table" from "keeps a copy of the list".
// Additive and uniquely named: `redactKeys` has no inverse, so a plausible key would leak into
// every other suite in the process.
redactKeys(['auditInputCanary']);

describe('an audit input is redacted through core’s own table', () => {
  test('a credential-named key never reaches the sink', () => {
    expect(
      auditableInput({ password: 'hunter2', token: 'tok_live', authorization: 'Bearer x' }),
    ).toEqual({ password: REDACTED, token: REDACTED, authorization: REDACTED });
  });

  test('a key registered at boot by defineEnv({ secret: true }) is redacted too', () => {
    expect(auditableInput({ auditInputCanary: 'value' })).toEqual({
      auditInputCanary: REDACTED,
    });
  });

  test('a boxed Secret is redacted by VALUE, wherever its key sits', () => {
    expect(auditableInput({ harmlessName: secret('sk_live_1') })).toEqual({
      harmlessName: REDACTED,
    });
  });

  test('redaction reaches nested objects and arrays, not just the top level', () => {
    expect(
      auditableInput({ user: { profile: { apiKey: 'k' } }, items: [{ password: 'p' }] }),
    ).toEqual({ user: { profile: { apiKey: REDACTED } }, items: [{ password: REDACTED }] });
  });
});

describe('an audit input is always representable, so a sink cannot throw on it', () => {
  test('a bigint is named rather than thrown on — JSON.stringify raises on one', () => {
    expect(auditableInput({ total: 10n })).toEqual({ total: UNREPRESENTABLE });
  });

  test('NaN and Infinity are named, never the silent null JSON.stringify writes', () => {
    expect(auditableInput({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toEqual({
      a: UNREPRESENTABLE,
      b: UNREPRESENTABLE,
    });
  });

  /**
   * Measured, and the reason this is not left to `JSON.stringify`'s own throw:
   * `JSON.stringify(cycle)` takes ~4.6s in Bun 1.4 before it raises. A sink paying that per write
   * is the audited path stalled, whether or not the error is caught.
   */
  test('a cycle is cut, not walked — and it costs nothing', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    const started = Bun.nanoseconds();
    const out = auditableInput(cyclic) as Record<string, unknown>;
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(250);
    expect(out['name']).toBe('a');
    expect(out['self']).toBe(UNREPRESENTABLE);
  });

  test('depth is bounded, so a deep input cannot overflow the stack inside the sink', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < AUDIT_INPUT_MAX_DEPTH + 20; i += 1) deep = { next: deep };
    let walked: unknown = auditableInput(deep);
    for (let i = 0; i < AUDIT_INPUT_MAX_DEPTH; i += 1) {
      walked = (walked as Record<string, unknown>)['next'];
    }
    expect(walked).toBe(UNREPRESENTABLE);
  });

  test('a Date becomes its instant, because a timestamp is the one thing an auditor reads', () => {
    expect(auditableInput({ when: new Date(1_700_000_000_000) })).toEqual({
      when: '2023-11-14T22:13:20.000Z',
    });
  });

  test('a function, a symbol and an undefined property are dropped or named, never emitted raw', () => {
    expect(auditableInput({ fn: () => 1, sym: Symbol('s'), gone: undefined, kept: 1 })).toEqual({
      fn: UNREPRESENTABLE,
      sym: UNREPRESENTABLE,
      kept: 1,
    });
  });

  test('the whole answer survives JSON.stringify, which is the only claim that matters', () => {
    const nasty = { total: 10n, when: new Date(0), token: 'x', deep: { fn: () => 1 } };
    expect(() => JSON.stringify(auditableInput(nasty))).not.toThrow();
  });

  test('an absent input stays absent — a parse that failed recorded no input at all', () => {
    expect(auditableInput(undefined)).toBeUndefined();
  });
});
