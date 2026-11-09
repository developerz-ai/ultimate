// The union of `@ultimat3/action`'s and `@ultimat3/query`'s policy-gate behaviour, asserted once
// against the one guard both adopt: the surface each projection maps to, the row reaching the
// predicate, the before-input stage, the decision event, and a code + reason that read the same
// whichever surface rendered the denial.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { memoryDecisionSink, resetDecisionSink, setDecisionSink } from './decisions';
import {
  type GuardedPrimitive,
  guardPrimitive,
  PRIMITIVE_POLICY_SURFACES,
  type PrimitiveSurface,
} from './guard-primitive';
import { clearPermissions, definePermissions } from './permissions';
import { allow, can } from './policy';
import { clearRoles, defineRoles } from './roles';
import { testActor } from './test-kit';

interface Input {
  readonly ownerId: string;
}

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read'] as const);
  defineRoles({ reader: { grants: ['post:read'] } });
});

afterEach(() => {
  resetDecisionSink();
});

afterAll(() => {
  clearPermissions();
  clearRoles();
});

const reader = testActor('reader', { roles: ['reader'] }).actor;
const guest = testActor('guest', { roles: [] }).actor;
const policy = can<Input>('post:read');

const full = (actor = guest) =>
  ({ stage: 'input', name: 'readPost', actor, input: { ownerId: 'u1' } }) as const;

describe('one surface table for both primitives', () => {
  test('action: server and job decide as job, http as http, mcp as mcp', () => {
    expect(PRIMITIVE_POLICY_SURFACES.action).toEqual({
      server: 'job',
      http: 'http',
      mcp: 'mcp',
      job: 'job',
    });
  });

  // The drift this guard exists for: `@ultimat3/query` judged an MCP read as `'job'`, while an
  // MCP action was judged as `'mcp'`. One agent surface, one policy surface.
  test('query: an MCP read is judged on the mcp surface, exactly as an MCP action is', () => {
    expect(PRIMITIVE_POLICY_SURFACES.query).toEqual({
      server: 'job',
      http: 'http',
      mcp: 'mcp',
      live: 'live',
    });
    expect(PRIMITIVE_POLICY_SURFACES.query.mcp).toBe(PRIMITIVE_POLICY_SURFACES.action.mcp);
  });

  const cases: readonly (readonly [GuardedPrimitive, PrimitiveSurface, string])[] = [
    ['action', 'server', 'job'],
    ['action', 'http', 'http'],
    ['action', 'mcp', 'mcp'],
    ['action', 'job', 'job'],
    ['query', 'server', 'job'],
    ['query', 'http', 'http'],
    ['query', 'mcp', 'mcp'],
    ['query', 'live', 'live'],
  ];
  for (const [kind, surface, rendered] of cases) {
    test(`${kind} on ${surface} renders the ${rendered} denial with one code and one reason`, () => {
      const denial = guardPrimitive(kind, policy, full(), surface);
      expect(denial).toMatchObject({
        kind,
        name: 'readPost',
        surface,
        code: 'X_FORBIDDEN',
        reason: 'actor lacks post:read',
      });
      expect(denial?.denial.surface).toBe(rendered as never);
    });
  }

  test('the decision event names the policy surface the projection mapped to', () => {
    const sink = memoryDecisionSink();
    setDecisionSink(sink);
    guardPrimitive('query', policy, full(), 'mcp');
    guardPrimitive('action', policy, full(), 'server');
    expect(sink.events.map((event) => event.surface)).toEqual(['mcp', 'job']);
  });
});

describe('the full stage', () => {
  test('an allowed caller gets undefined — the call proceeds', () => {
    expect(guardPrimitive('action', policy, full(reader), 'http')).toBeUndefined();
  });

  test('the row reaches the predicate as its own field; an absent row is null', () => {
    const seen: unknown[] = [];
    const rowRule = can<Input, { readonly owner: string }>('post:read', ({ row }) => {
      seen.push(row);
      return true;
    });
    guardPrimitive('query', rowRule, { ...full(reader), row: { owner: 'u1' } }, 'live');
    guardPrimitive('action', rowRule, full(reader), 'server');
    expect(seen).toEqual([{ owner: 'u1' }, null]);
  });

  test('a predicate reads the parsed input', () => {
    const owns = can<Input>('post:read', ({ actor, input }) => input.ownerId === actor?.id);
    const denial = guardPrimitive('action', owns, full(reader), 'http');
    expect(denial?.code).toBe('X_FORBIDDEN');
  });
});

describe('the before-input stage', () => {
  const actorOnly = (actor = guest) => ({ stage: 'actor', name: 'refund', actor }) as const;

  test('an actor refused whatever they send is denied before the parse', () => {
    const denial = guardPrimitive('action', policy, actorOnly(), 'http');
    expect(denial?.code).toBe('X_FORBIDDEN');
    expect(denial?.denial).toMatchObject({ surface: 'http', status: 403 });
  });

  test('nobody signed in is 401, not 403', () => {
    const denial = guardPrimitive('query', policy, actorOnly(null as never), 'http');
    expect(denial?.code).toBe('X_UNAUTHENTICATED');
    expect(denial?.denial).toMatchObject({ surface: 'http', status: 401 });
  });

  test('undecided — a predicate would have to read the input — passes, and emits nothing', () => {
    const sink = memoryDecisionSink();
    setDecisionSink(sink);
    let ran = false;
    const reads = can<Input>('post:read', () => {
      ran = true;
      return false;
    });
    expect(guardPrimitive('query', reads, actorOnly(reader), 'mcp')).toBeUndefined();
    expect(ran).toBe(false);
    expect(sink.events).toEqual([]);
  });

  test('allow() is allowed before the parse', () => {
    expect(guardPrimitive('action', allow('public'), actorOnly(), 'mcp')).toBeUndefined();
  });
});

describe('a surface the primitive does not run on', () => {
  test('an action on live is X_POLICY_SURFACE_UNKNOWN, never a decision', () => {
    let thrown: unknown;
    try {
      guardPrimitive('action', policy, full(), 'live' as never);
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_POLICY_SURFACE_UNKNOWN');
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain("'server', 'http', 'mcp', 'job'");
  });

  test('an inherited key is refused too, not dispatched', () => {
    expect(() => guardPrimitive('query', policy, full(), 'valueOf' as never)).toThrow(
      /X_POLICY_SURFACE_UNKNOWN/,
    );
    expect(() => guardPrimitive('toString' as never, policy, full(), 'http' as never)).toThrow(
      /X_POLICY_SURFACE_UNKNOWN/,
    );
    // `Object.prototype.toString` is a function, and a function OWNS `length`: an unchecked kind
    // indexed its way to `0` and handed that to `enforce()` as a surface.
    expect(() => guardPrimitive('toString' as never, policy, full(), 'length' as never)).toThrow(
      /guardPrimitive\(\) was handed surface/,
    );
  });
});
