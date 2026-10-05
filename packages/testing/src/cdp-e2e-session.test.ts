// The browser half over a fake connection: what attaches at which level and paused how, what a new
// tab waits for, and that the offline switch and init scripts reach targets attached LATER. The real
// browser run is `e2e/cdp-session.e2e.test.ts`; this is the part a fake can pin exactly.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { cdpE2eSession } from './cdp-e2e-session';
import { OFFLINE_FIRST_SCRIPT, RESTORE_ONLINE } from './cdp-offline-script';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/**
 * How many `navigator.onLine` reads after a switch still answer the PREVIOUS state — Chrome applies
 * the condition to a renderer asynchronously, which is the race #572 lost. `Infinity`: never flips.
 */
interface Lag {
  readonly reads: number;
}

/** A connection that records every call and lets the test fire events at the session. */
function fake(
  held: ReadonlySet<string> = new Set(),
  lag: Lag = { reads: 0 },
): {
  readonly connection: CdpConnection;
  readonly calls: Call[];
  emit(method: string, params: Record<string, unknown>): void;
} {
  const calls: Call[] = [];
  // Per session: what the page reports, what it will report once the lag runs out, and how many
  // more reads still see the old answer.
  const onLine = new Map<string, { now: boolean; next: boolean; stale: number }>();
  // A session in `held` answers nothing until it is released — Chrome's paused SharedWorker, whose
  // `Network.enable` measured unanswered for the whole 30 s deadline in a full `x verify`.
  const waiting = new Map<string, (() => void)[]>();
  const listeners = new Map<string, CdpEventListener[]>();
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
      if (sessionId !== undefined && method === 'Network.emulateNetworkConditions') {
        const page = onLine.get(sessionId) ?? { now: true, next: true, stale: 0 };
        onLine.set(sessionId, { ...page, next: params['offline'] !== true, stale: lag.reads });
      }
      if (
        sessionId !== undefined &&
        method === 'Runtime.evaluate' &&
        params['expression'] === 'navigator.onLine'
      ) {
        const page = onLine.get(sessionId) ?? { now: true, next: true, stale: 0 };
        const settled = page.stale <= 0 ? { ...page, now: page.next } : page;
        onLine.set(sessionId, { ...settled, stale: page.stale - 1 });
        return Promise.resolve({ result: { result: { type: 'boolean', value: settled.now } } });
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
    for (const listener of listeners.get(method) ?? []) listener(params, undefined);
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

  test('a pinned Accept-Language reaches every target before it is released', async () => {
    const { connection, calls, emit } = fake();
    const session = await cdpE2eSession({
      connection,
      loadTimeoutMs: 500,
      acceptLanguage: 'es-co',
    });
    await session.newTab();
    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'shared_worker', targetId: 'w-1' },
    });
    await settle();

    for (const target of ['tab-session', 'worker-session']) {
      const on = calls.filter((call) => call.sessionId === target);
      const pin = on.findIndex((call) => call.method === 'Network.setExtraHTTPHeaders');
      expect(on[pin]?.params).toEqual({ headers: { 'accept-language': 'es-co' } });
      expect(pin).toBeLessThan(
        on.findIndex((call) => call.method === 'Runtime.runIfWaitingForDebugger'),
      );
    }
  });

  test('with nothing pinned no header is sent — the browser keeps its own', async () => {
    const { connection, calls } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.newTab();
    expect(calls.some((call) => call.method === 'Network.setExtraHTTPHeaders')).toBe(false);
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
    const sources = (source: string) =>
      scripts.filter((call) => call.params['source'] === source).map((call) => call.sessionId);
    expect(sources('window.__init = true;')).toEqual(['tab-session']);
    // A page attached while cut reads `navigator.onLine` false from its first script too.
    expect(sources(OFFLINE_FIRST_SCRIPT)).toEqual(['tab-session']);
  });

  // The refusal used to be swallowed AND the page dropped from the set: every later offline() then
  // skipped that tab's `navigator.onLine`, and the test after it read an online page as proof.
  test('a page whose restore is refused surfaces it, and is still switched the next time', async () => {
    const { connection, calls } = fake();
    let refuse = true;
    const flaky: CdpConnection = {
      ...connection,
      send(method, params, sessionId) {
        if (refuse && method === 'Page.removeScriptToEvaluateOnNewDocument') {
          return Promise.reject(new Error('Script not found'));
        }
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          void connection.send(method, params, sessionId);
          return Promise.resolve({ result: { identifier: '1' } });
        }
        return connection.send(method, params, sessionId);
      },
    };
    const session = await cdpE2eSession({ connection: flaky, loadTimeoutMs: 500 });
    await session.newTab();
    await session.offline(true);

    const thrown: unknown = await session.offline(false).then(
      () => expect.unreachable('the refused restore vanished'),
      (error: unknown) => error,
    );
    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    const restores = (): number =>
      calls.filter(
        (call) =>
          call.method === 'Runtime.evaluate' &&
          call.sessionId === 'tab-session' &&
          call.params['expression'] === RESTORE_ONLINE,
      ).length;
    expect(restores()).toBe(1);

    refuse = false;
    await session.offline(true);
    await session.offline(false);
    expect(restores()).toBe(2);
  });

  // #572: `offline(true)` resolved once the condition was SENT, and a `fetch` fired on the next line
  // raced the renderer applying it — on a slow runner the page was still online and the fetch got
  // through. The switch is thrown only once every page READS the state it was switched to.
  describe('offline() returns once every page reads the state it was switched to', () => {
    const reads = (calls: readonly Call[], session: string): number =>
      calls.filter(
        (call) =>
          call.method === 'Runtime.evaluate' &&
          call.sessionId === session &&
          call.params['expression'] === 'navigator.onLine',
      ).length;

    test('a page that applies the cut late is waited for, both ways', async () => {
      const { connection, calls, emit } = fake(new Set(), { reads: 3 });
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 2_000 });
      await session.newTab();
      emit('Target.attachedToTarget', {
        sessionId: 'second-session',
        targetInfo: { type: 'page', targetId: 'tab-2' },
      });
      await settle();

      await session.offline(true);
      // Three stale reads, then the one that confirms — in EVERY page, not only the first.
      expect(reads(calls, 'tab-session')).toBe(4);
      expect(reads(calls, 'second-session')).toBe(4);

      await session.offline(false);
      expect(reads(calls, 'tab-session')).toBe(8);
      expect(reads(calls, 'second-session')).toBe(8);
    });

    test('a page that never reads the switched state is a bounded X_CDP_TIMEOUT', async () => {
      const { connection } = fake(new Set(), { reads: Number.POSITIVE_INFINITY });
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 300 });
      await session.newTab();

      const started = performance.now();
      const thrown: unknown = await session.offline(true).then(
        () => expect.unreachable('offline(true) resolved over a page that still reads online'),
        (error: unknown) => error,
      );
      expect((thrown as { code?: string }).code).toBe('X_CDP_TIMEOUT');
      expect((thrown as { cause?: string }).cause).toContain('navigator.onLine === false');
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    test('workers are not asked: navigator.onLine is a page`s to report', async () => {
      const { connection, calls, emit } = fake();
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
      emit('Target.attachedToTarget', {
        sessionId: 'worker-session',
        targetInfo: { type: 'shared_worker', targetId: 'w-1' },
      });
      await settle();
      await session.offline(true);
      expect(reads(calls, 'worker-session')).toBe(0);
    });
  });

  test('every WebSocket and request the browser reports is logged, in order', async () => {
    const { connection, emit } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });

    emit('Network.webSocketCreated', { url: 'ws://app.test/_x/sync' });
    emit('Network.requestWillBeSent', { request: { method: 'POST', url: 'http://app.test/api' } });

    expect(session.sockets()).toEqual(['ws://app.test/_x/sync']);
    expect(session.requests()).toEqual(['POST http://app.test/api']);
  });

  // Each `send` was awaited bare, so one closed tab's dead session rejected the whole call and the
  // tabs after it never got the script — the case `offline()` already guarded.
  test('a closed tab does not stop an init script reaching the tabs still open', async () => {
    const { connection, calls, emit } = fake();
    const dead = new Set<string>();
    const guarded: CdpConnection = {
      ...connection,
      send(method, params, sessionId) {
        if (sessionId !== undefined && dead.has(sessionId)) {
          // What a CDP session that has gone away answers: a refusal, for every call.
          return Promise.reject(new Error(`session ${sessionId} is closed`));
        }
        return connection.send(method, params, sessionId);
      },
    };
    const session = await cdpE2eSession({ connection: guarded, loadTimeoutMs: 500 });
    for (const [sessionId, targetId] of [
      ['closed-session', 'closed-tab'],
      ['open-session', 'open-tab'],
    ]) {
      emit('Target.attachedToTarget', { sessionId, targetInfo: { type: 'page', targetId } });
    }
    await settle();
    dead.add('closed-session');

    await session.addInitScript('window.__late = true;');

    const reached = calls
      .filter((call) => call.params['source'] === 'window.__late = true;')
      .map((call) => call.sessionId);
    expect(reached).toEqual(['open-session']);
  });
});
