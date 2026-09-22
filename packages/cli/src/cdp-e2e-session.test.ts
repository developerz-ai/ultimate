// The browser half over a fake connection: what attaches at which level and paused how, what a new
// tab waits for, and that the offline switch and init scripts reach targets attached LATER. The real
// browser run is `e2e/cdp-session.e2e.test.ts`; this is the part a fake can pin exactly.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpResult } from './cdp-connection';
import { cdpE2eSession } from './cdp-e2e-session';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/** A connection that records every call and lets the test fire events at the session. */
function fake(held: ReadonlySet<string> = new Set()): {
  readonly connection: CdpConnection;
  readonly calls: Call[];
  emit(method: string, params: Record<string, unknown>): void;
} {
  const calls: Call[] = [];
  // A session in `held` answers nothing until it is released — Chrome's paused SharedWorker, whose
  // `Network.enable` measured unanswered for the whole 30 s deadline in a full `x verify`.
  const waiting = new Map<string, (() => void)[]>();
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  const connection: CdpConnection = {
    send(method, params = {}, sessionId): Promise<CdpResult> {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') {
        // Chrome announces the new tab through the auto-attach, not through this reply.
        queueMicrotask(() =>
          emit('Target.attachedToTarget', {
            sessionId: 'tab-session',
            targetInfo: { type: 'page', targetId: 'tab-1' },
          }),
        );
        return Promise.resolve({ result: { targetId: 'tab-1' } });
      }
      if (sessionId !== undefined && held.has(sessionId)) {
        if (method === 'Runtime.runIfWaitingForDebugger') {
          for (const answer of waiting.get(sessionId) ?? []) answer();
          waiting.delete(sessionId);
          return Promise.resolve({ result: {} });
        }
        return new Promise((resolve) => {
          waiting.set(sessionId, [
            ...(waiting.get(sessionId) ?? []),
            () => resolve({ result: {} }),
          ]);
        });
      }
      return Promise.resolve({ result: {} });
    },
    once: () => Promise.resolve(true),
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
      return () => undefined;
    },
    close: () => undefined,
  };
  const emit = (method: string, params: Record<string, unknown>): void => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  return { connection, calls, emit };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('cdpE2eSession', () => {
  test('attaches every target at browser level, PAUSED, so a worker is watched from byte one', async () => {
    const { connection, calls } = fake();
    await cdpE2eSession({ connection, loadTimeoutMs: 500 });

    const auto = calls.find((call) => call.method === 'Target.setAutoAttach');
    expect(auto?.sessionId).toBeUndefined();
    expect(auto?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  });

  test('a new tab is handed out only once attached, enabled and released', async () => {
    const { connection, calls } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });

    const tab = await session.newTab();

    expect(tab.targetId).toBe('tab-1');
    const onTab = calls.filter((call) => call.sessionId === 'tab-session').map((c) => c.method);
    expect(onTab).toEqual([
      'Network.enable',
      'Page.enable',
      'Runtime.enable',
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ]);
  });

  test('a paused target that answers nothing until released is still released at once', async () => {
    // The deadlock: configuration AWAITED before the release, on a target that serves no command
    // while it waits for a debugger. The SharedWorker stayed paused for the full call deadline,
    // and the shared gate page stalled on it — `offline-feed.e2e.test.ts` timing out in `x verify`.
    const { connection, calls, emit } = fake(new Set(['worker-session']));
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.offline(true);

    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'shared_worker', targetId: 'w-1' },
      waitingForDebugger: true,
    });
    await settle();

    const onWorker = calls
      .filter((call) => call.sessionId === 'worker-session')
      .map((c) => c.method);
    // Still configured BEFORE the release in dispatch order, so its first request is watched.
    expect(onWorker).toEqual([
      'Network.enable',
      'Network.emulateNetworkConditions',
      'Runtime.runIfWaitingForDebugger',
    ]);
  });

  test('a worker attached while offline inherits the cut; init scripts reach later tabs', async () => {
    const { connection, calls, emit } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.addInitScript('window.__init = true;');
    await session.offline(true);

    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'shared_worker', targetId: 'w-1' },
    });
    await session.newTab();
    await settle();

    const conditions = calls.filter(
      (call) => call.method === 'Network.emulateNetworkConditions' && call.params['offline'],
    );
    expect(conditions.map((call) => call.sessionId)).toContain('worker-session');
    const scripts = calls.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument');
    expect(scripts.map((call) => call.sessionId)).toEqual(['tab-session']);
  });

  test('every WebSocket and request the browser reports is logged, in order', async () => {
    const { connection, emit } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });

    emit('Network.webSocketCreated', { url: 'ws://app.test/_x/sync' });
    emit('Network.requestWillBeSent', { request: { method: 'POST', url: 'http://app.test/api' } });

    expect(session.sockets()).toEqual(['ws://app.test/_x/sync']);
    expect(session.requests()).toEqual(['POST http://app.test/api']);
  });
});
