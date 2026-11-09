// The rate-limit and audit gate shapes `@ultimat3/action` and `@ultimat3/query` share — the rules
// each package spelled for itself, asserted once.

import { describe, expect, test } from 'bun:test';
import { agentActor, anonymousActor } from './actor';
import { UltimateError } from './errors';
import {
  AUDIT_SINK_FAILED_EVENT,
  auditFailureOf,
  auditOutcomeOf,
  fixedRateLimitOf,
  rateLimitScopeOf,
  rateLimitSpendsOn,
  rateLimitSubjectOf,
  resolvedRateLimitOf,
} from './gate-shapes';

class Denied extends UltimateError {
  constructor() {
    super({ code: 'X_FORBIDDEN', cause: 'denied', fix: 'x policy explain demo --json' });
  }
}

const isDenied = (error: unknown): boolean => error instanceof Denied;

describe('audit shapes', () => {
  test('a denial is denied, anything else that threw is failed', () => {
    expect(auditOutcomeOf(new Denied(), isDenied)).toBe('denied');
    expect(auditOutcomeOf('boom', isDenied)).toBe('failed');
  });

  test('a probe that throws fails closed to failed, never replacing the caller error', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Denied();
        },
      },
    );
    expect(auditOutcomeOf(hostile, isDenied)).toBe('failed');
  });

  test('the failure carries the X_ code of an UltimateError, null otherwise, and the value verbatim', () => {
    const denied = new Denied();
    expect(auditFailureOf(denied)).toEqual({ code: 'X_FORBIDDEN', error: denied });
    expect(auditFailureOf(42)).toEqual({ code: null, error: 42 });
  });

  test('one log event name, so one alert rule covers every audited primitive', () => {
    expect(AUDIT_SINK_FAILED_EVENT).toBe('audit.sink.failed');
  });
});

describe('rate-limit shapes', () => {
  test("'server' spends nothing; every surface a caller arrives on does", () => {
    expect(rateLimitSpendsOn('server')).toBe(false);
    for (const surface of ['http', 'mcp', 'job', 'live'] as const) {
      expect(rateLimitSpendsOn(surface)).toBe(true);
    }
  });

  test('the bucket key is namespaced by primitive, never the bare name', () => {
    expect(rateLimitScopeOf('action', 'publish')).toBe('action:publish');
    expect(rateLimitScopeOf('query', 'publish')).toBe('query:publish');
  });

  test('a signed-in caller is its id and org; an anonymous one keeps an org it carries', () => {
    const agent = agentActor({ id: 'a1', orgId: 'o1' });
    expect(rateLimitSubjectOf(agent, '10.0.0.1')).toEqual({
      actorId: 'a1',
      orgId: 'o1',
      ip: '10.0.0.1',
    });
    expect(rateLimitSubjectOf(anonymousActor(), null)).toEqual({
      actorId: null,
      orgId: null,
      ip: null,
    });
    // A job run is the worker's anonymous identity carrying the job's org.
    const jobRun = Object.freeze({ ...anonymousActor(), orgId: 'o2' });
    expect(rateLimitSubjectOf(jobRun, null).orgId).toBe('o2');
  });

  test('a resolved limit is the number or what the resolver answers; anything else is NaN', async () => {
    expect(await resolvedRateLimitOf({ limit: 5, windowMs: 1000 }, {})).toBe(5);
    expect(await resolvedRateLimitOf({ limit: async () => 7, windowMs: 1000 }, {})).toBe(7);
    const lying = { limit: () => '7' as unknown as number, windowMs: 1000 };
    expect(await resolvedRateLimitOf(lying, {})).toBeNaN();
  });

  test('the fixed pair, or null for a limit resolved per call', () => {
    expect(fixedRateLimitOf({ limit: 5, windowMs: 1000 })).toEqual({ limit: 5, windowMs: 1000 });
    expect(fixedRateLimitOf({ limit: () => 5, windowMs: 1000 })).toBeNull();
    expect(fixedRateLimitOf(undefined)).toBeNull();
  });
});
