// Both transports, both branches. The stdio branch is the one that shipped broken: nothing in
// this package installs a root context, so a bare `withChildContext` answered `X_NO_CONTEXT` for
// every tool call `x mcp serve` received.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { createContext, hasContext, runWithContext, useContext, userActor } from '@ultimat3/core';
import { asCallerContext } from './caller-context';

const alice: Actor = userActor({ id: 'alice', orgId: 'org-a' });
const agent: Actor = userActor({ id: 'agent-1', orgId: 'org-b' });

describe('the ambient identity for a tool call', () => {
  test('stdio: with no request in flight it installs a root context rather than throwing', () => {
    // `x mcp serve` has no surrounding request. `withChildContext` alone calls `useContext()`,
    // which throws X_NO_CONTEXT here — so every app tool call over stdio failed before running.
    expect(hasContext()).toBe(false);
    const seen = asCallerContext(agent, () => useContext().actor);
    expect(seen?.id).toBe('agent-1');
  });

  test('http: with a request in flight the caller REPLACES the surrounding actor', () => {
    // The leak this closes: an agent token authorizing as agent-1 while the repo reads run as
    // the session cookie's user, because the two identities came from two different places.
    const answer = runWithContext(createContext({ actor: alice }), () =>
      asCallerContext(agent, () => useContext().actor),
    );
    expect(answer?.id).toBe('agent-1');
    expect(answer?.orgId).toBe('org-b');
  });

  test('http: the surrounding context is restored afterwards', () => {
    const after = runWithContext(createContext({ actor: alice }), () => {
      asCallerContext(agent, () => undefined);
      return useContext().actor;
    });
    expect(after?.id).toBe('alice');
  });

  test('the root context it installs does not outlive the call', () => {
    asCallerContext(agent, () => undefined);
    expect(hasContext()).toBe(false);
  });

  test('a value returned by fn is handed back on both branches', () => {
    expect(asCallerContext(agent, () => 'stdio')).toBe('stdio');
    expect(
      runWithContext(createContext({ actor: alice }), () => asCallerContext(agent, () => 'http')),
    ).toBe('http');
  });
});
