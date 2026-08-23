// What the server render's client answers, and what it refuses. The hooks' side of the same rule
// is in `hooks.test.ts`; this covers the client itself, including the members no hook exposes.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { serverRenderLiveClient } from './server-render-client';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;
  }
  return 'nothing was thrown';
};

describe('the server render client', () => {
  test('is one per process, because it holds nothing per request', () => {
    expect(serverRenderLiveClient()).toBe(serverRenderLiveClient());
  });

  /**
   * The leak one shared instance would otherwise be: `LiveClient` keys every subscription into a
   * Map that lives as long as the client, so a process-wide client that registered one per render
   * would grow by an entry per request, forever, and hold a row window with each. Two handles from
   * one client here, and neither knows about the other.
   */
  test('registers nothing, so a thousand renders leave nothing behind', () => {
    const client = serverRenderLiveClient();
    const first = client.useLive({ name: 'feed' }, { orgId: 'o1' });
    const second = client.useLive({ name: 'feed' }, { orgId: 'o2' });
    expect(first).not.toBe(second);
    first.unsubscribe();
    expect(second.state()).toBe('loading');
  });

  test('answers loading with no rows, never offline and never live', () => {
    const handle = serverRenderLiveClient().useLive({ name: 'feed' }, null);
    expect(handle.state()).toBe('loading');
    expect(handle.rows()).toEqual([]);
    expect(handle.cursor()).toBeNull();
  });

  /** A page holding a handle across a `using` scope must not fail the render it is ending. */
  test('disposing a handle is a no-op, twice over', () => {
    const handle = serverRenderLiveClient().useLive({ name: 'feed' }, null);
    handle.unsubscribe();
    handle[Symbol.dispose]();
    expect(handle.state()).toBe('loading');
  });

  test('reports connected, so no document server-renders an offline banner', () => {
    expect(serverRenderLiveClient().connected).toBe(true);
    expect(serverRenderLiveClient().reconnectAt()).toBeNull();
    expect(serverRenderLiveClient().appUpdateAvailable()).toBeNull();
  });

  test('has no offline queue, so a queue count on the server is zero and not a guess', () => {
    expect(serverRenderLiveClient().queue).toBeUndefined();
  });

  /**
   * Every operation that can only mean "talk to the socket". A no-op would be worse than a
   * refusal on each of them: a dropped mutation looks like a write that happened.
   */
  test.each([
    ['mutate', (): unknown => serverRenderLiveClient().mutate({ name: 'likePost' }, null)],
    ['drain', (): unknown => serverRenderLiveClient().drain()],
  ])('refuses %s with X_LIVE_SERVER_RENDER', (_name, run) => {
    expect(codeOf(run)).toBe('X_LIVE_SERVER_RENDER');
  });

  /** The refusal has to name the operation, or two call sites share one indistinguishable line. */
  test('the refusal names the operation that ran', () => {
    try {
      void serverRenderLiveClient().drain();
      expect.unreachable('drain() should have been refused');
    } catch (error) {
      expect(error instanceof UltimateError && error.cause).toContain('drain()');
      expect(error instanceof UltimateError && error.fix).toContain('hasLiveClient()');
    }
  });

  /** A queue listener is accepted and never called: there is no queue and nothing can change it. */
  test('accepts a queue listener and hands back a release that is safe to call', () => {
    const release = serverRenderLiveClient().onQueueChange(() => {
      expect.unreachable('nothing on the server can change a queue that does not exist');
    });
    expect(() => release()).not.toThrow();
  });
});
