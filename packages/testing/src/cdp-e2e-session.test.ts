// The browser half over a fake connection: what attaches at which level and paused how, what a new
// tab waits for, and that the offline switch and init scripts reach targets attached LATER. The real
// browser run is `e2e/cdp-session.e2e.test.ts`; this is the part a fake can pin exactly.

import { describe, expect, test } from 'bun:test';
import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { cdpE2eSession } from './cdp-e2e-session';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import { OFFLINE_FIRST_SCRIPT, RESTORE_ONLINE } from './cdp-offline-script';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/**
 * When a page APPLIES a sent network condition — Chrome does it asynchronously, which is the race
 * #572 lost. `at-once`: on the send. `on-apply`: only when the test calls `apply(session)`.
 * `never`: the page keeps reading its old state.
 */
type Lag = 'at-once' | 'on-apply' | 'never';

interface FakeOptions {
  /** Sessions that answer nothing until released — Chrome's paused SharedWorker. */
  readonly held?: ReadonlySet<string>;
  readonly lag?: Lag;
  /**
   * Sessions whose FIRST confirmation is refused by a navigation: the context it ran in is
   * destroyed, and the new document's `Runtime.executionContextCreated` lands before the refusal.
   */
  readonly navigating?: ReadonlySet<string>;
}

interface Page {
  now: boolean;
  next: boolean;
  /** Confirmations held by `awaitPromise` until the page reads the state each one asks for. */
  asking: { readonly online: boolean; readonly answer: () => void }[];
}

/** The state a confirmation expression asks for, or undefined for any other evaluate. */
const confirming = (params: Record<string, unknown>): boolean | undefined => {
  const expression = params['expression'];
  if (params['awaitPromise'] !== true || typeof expression !== 'string') return undefined;
  if (expression.startsWith('navigator.onLine === true')) return true;
  if (expression.startsWith('navigator.onLine === false')) return false;
  return undefined;
};

/** A connection that records every call and lets the test fire events at the session. */
function fake(options: FakeOptions = {}): {
  readonly connection: CdpConnection;
  readonly calls: Call[];
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void;
  /** Resolves once `session` has been sent its release — the last step of its attachment. */
  released(session: string): Promise<void>;
  /** Resolves once `session` has been asked to confirm a state and is holding the answer. */
  asked(session: string): Promise<void>;
  /** The page applies the condition last sent to it, answering every confirmation it now meets. */
  apply(session: string): void;
} {
  const { held = new Set<string>(), lag = 'at-once', navigating = new Set<string>() } = options;
  const calls: Call[] = [];
  const pages = new Map<string, Page>();
  const page = (session: string): Page => {
    const known = pages.get(session) ?? { now: true, next: true, asking: [] };
    pages.set(session, known);
    return known;
  };
  const refused = new Set<string>();
  // One promise per (event, session), created by whichever side gets there first.
  const signals = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const signal = (key: string) => {
    const known = signals.get(key);
    if (known !== undefined) return known;
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const made = { promise, resolve };
    signals.set(key, made);
    return made;
  };
  const apply = (session: string): void => {
    const target = page(session);
    target.now = target.next;
    const due = target.asking.filter((asked) => asked.online === target.now);
    target.asking = target.asking.filter((asked) => asked.online !== target.now);
    for (const one of due) one.answer();
  };
  // A session in `held` answers nothing until it is released — Chrome's paused SharedWorker, whose
  // `Network.enable` measured unanswered for the whole 30 s deadline in a full `x verify`.
  const waiting = new Map<string, (() => void)[]>();
  const listeners = new Map<string, CdpEventListener[]>();
  let tabs = 0;
  const connection: CdpConnection = {
    send(method, params = {}, sessionId, deadlineMs = 30_000): Promise<CdpResult> {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') {
        tabs += 1;
        const targetId = `tab-${String(tabs)}`;
        const session = tabs === 1 ? 'tab-session' : `tab-session-${String(tabs)}`;
        // Chrome announces the new tab through the auto-attach, not through this reply.
        queueMicrotask(() =>
          emit('Target.attachedToTarget', {
            sessionId: session,
            targetInfo: { type: 'page', targetId },
          }),
        );
        return Promise.resolve({ result: { targetId } });
      }
      if (sessionId === undefined) return Promise.resolve({ result: {} });
      if (method === 'Runtime.runIfWaitingForDebugger') signal(`released:${sessionId}`).resolve();
      if (method === 'Network.emulateNetworkConditions') {
        page(sessionId).next = params['offline'] !== true;
        if (lag === 'at-once') apply(sessionId);
      }
      const online = method === 'Runtime.evaluate' ? confirming(params) : undefined;
      if (online !== undefined) {
        if (navigating.has(sessionId) && !refused.has(sessionId)) {
          refused.add(sessionId);
          emit('Runtime.executionContextCreated', { context: { id: 2 } }, sessionId);
          return Promise.reject(
            new CdpCallFailedError({ method, detail: 'Execution context was destroyed.' }),
          );
        }
        const target = page(sessionId);
        const answer = { result: { result: { type: 'boolean', value: true } } };
        if (target.now === online) return Promise.resolve(answer);
        // Held like the real connection holds it: answered when the page flips, refused at the
        // call's deadline — the bound `cdpConnectOver` puts on every call.
        return new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new CdpTimeoutError({ method, timeoutMs: deadlineMs })),
            deadlineMs,
          );
          target.asking.push({
            online,
            answer: () => {
              clearTimeout(deadline);
              resolve(answer);
            },
          });
          signal(`asked:${sessionId}`).resolve();
        });
      }
      if (held.has(sessionId)) {
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
      return () => {
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((subscribed) => subscribed !== listener),
        );
      };
    },
    close: () => undefined,
  };
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string): void => {
    for (const listener of listeners.get(method) ?? []) listener(params, sessionId);
  };
  return {
    connection,
    calls,
    emit,
    released: (session) => signal(`released:${session}`).promise,
    asked: (session) => signal(`asked:${session}`).promise,
    apply,
  };
}

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
    const { connection, calls, emit, released } = fake();
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
    await released('worker-session');

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
    const { connection, calls, emit, released } = fake({ held: new Set(['worker-session']) });
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.offline(true);

    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'shared_worker', targetId: 'w-1' },
      waitingForDebugger: true,
    });
    await released('worker-session');

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
    const { connection, calls, emit, released } = fake();
    const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
    await session.addInitScript('window.__init = true;');
    await session.offline(true);

    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'shared_worker', targetId: 'w-1' },
    });
    await session.newTab();
    await released('worker-session');

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
    const confirmations = (calls: readonly Call[], session: string): number =>
      calls.filter(
        (call) =>
          call.method === 'Runtime.evaluate' &&
          call.sessionId === session &&
          confirming(call.params) !== undefined,
      ).length;

    /** Every task already queued has run: only a promise that is still WAITING is unsettled. */
    const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    test('a page that applies the cut late is waited for, both ways, asked ONCE each', async () => {
      const { connection, calls, asked, apply } = fake({ lag: 'on-apply' });
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 2_000 });
      await session.newTab();
      await session.newTab();

      for (const online of [false, true]) {
        let returned = false;
        const switched = session.offline(!online).then(() => {
          returned = true;
        });
        await Promise.all([asked('tab-session'), asked('tab-session-2')]);
        apply('tab-session');
        await drained();
        // One page reads the state; the other has not applied it yet. Not done.
        expect({ online, returned }).toEqual({ online, returned: false });
        apply('tab-session-2');
        await switched;
      }
      // The page answers when it flips — asked once per switch, never read again and again.
      expect(confirmations(calls, 'tab-session')).toBe(2);
      expect(confirmations(calls, 'tab-session-2')).toBe(2);
    });

    test('a page mid-navigation is asked again in the document that replaces it', async () => {
      const { connection, calls } = fake({ navigating: new Set(['tab-session']) });
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 2_000 });
      await session.newTab();

      await session.offline(true);
      expect(confirmations(calls, 'tab-session')).toBe(2);
    });

    test('a page that never reads the switched state is a bounded X_CDP_TIMEOUT naming it', async () => {
      const { connection, asked, apply } = fake({ lag: 'on-apply' });
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 300 });
      await session.newTab();
      await session.newTab();

      const started = performance.now();
      const switching = session.offline(true);
      await asked('tab-session');
      apply('tab-session');
      const thrown: unknown = await switching.then(
        () => expect.unreachable('offline(true) resolved over a page that still reads online'),
        (error: unknown) => error,
      );
      expect((thrown as { code?: string }).code).toBe('X_CDP_TIMEOUT');
      const cause = (thrown as { cause?: string }).cause;
      expect(cause).toContain('navigator.onLine === false in page session tab-session-2');
      expect(cause).not.toContain('tab-session,');
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    test('workers are not asked: navigator.onLine is a page`s to report', async () => {
      const { connection, calls, emit, released } = fake();
      const session = await cdpE2eSession({ connection, loadTimeoutMs: 500 });
      emit('Target.attachedToTarget', {
        sessionId: 'worker-session',
        targetInfo: { type: 'shared_worker', targetId: 'w-1' },
      });
      await released('worker-session');
      await session.offline(true);
      expect(confirmations(calls, 'worker-session')).toBe(0);
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
    const { connection, calls } = fake();
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
    // Each `newTab()` returns once its tab is attached, enabled, released and published.
    await session.newTab();
    await session.newTab();
    dead.add('tab-session');

    await session.addInitScript('window.__late = true;');

    const reached = calls
      .filter((call) => call.params['source'] === 'window.__late = true;')
      .map((call) => call.sessionId);
    expect(reached).toEqual(['tab-session-2']);
  });
});
