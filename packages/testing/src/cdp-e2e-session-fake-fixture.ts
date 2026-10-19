// The fake CDP connection `cdp-e2e-session.test.ts` drives the browser half over: it records every
// call, holds a paused target's answers, and models when a page APPLIES a network condition — its
// `navigator.onLine` and, separately, what a request from it meets.

import type { CdpConnection, CdpEventListener, CdpResult } from './cdp-connection';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import { NETWORK_PROBE, NETWORK_PROBE_PATH } from './cdp-network-probe';

export interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/**
 * When a page APPLIES a sent network condition — Chrome does it asynchronously, which is the race
 * #572 lost. `at-once`: on the send. `on-apply`: only when the test calls `apply(session)`.
 * `never`: the page keeps reading its old state.
 */
export type Lag = 'at-once' | 'on-apply' | 'never';

export interface FakeOptions {
  /** Sessions that answer nothing until released — Chrome's paused SharedWorker. */
  readonly held?: ReadonlySet<string>;
  readonly lag?: Lag;
  /**
   * Sessions whose FIRST confirmation is refused by a navigation: the context it ran in is
   * destroyed, and the new document's `Runtime.executionContextCreated` lands before the refusal.
   */
  readonly navigating?: ReadonlySet<string>;
  /**
   * Probes that still see the OLD network after a condition is applied — Chrome's network service
   * enforcing the cut after the page already reads `navigator.onLine === false`.
   */
  readonly netLag?: number;
}

interface Page {
  now: boolean;
  next: boolean;
  /** What a request from the page meets, and how many probes still meet the old state. */
  net: boolean;
  stale: number;
  /** Confirmations held by `awaitPromise` until the page reads the state each one asks for. */
  asking: { readonly online: boolean; readonly answer: () => void }[];
}

/** The state a confirmation expression asks for, or undefined for any other evaluate. */
export const confirming = (params: Record<string, unknown>): boolean | undefined => {
  const expression = params['expression'];
  if (params['awaitPromise'] !== true || typeof expression !== 'string') return undefined;
  if (expression.startsWith('navigator.onLine === true')) return true;
  if (expression.startsWith('navigator.onLine === false')) return false;
  return undefined;
};

/** A connection that records every call and lets the test fire events at the session. */
export function fake(options: FakeOptions = {}): {
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
  const {
    held = new Set<string>(),
    lag = 'at-once',
    navigating = new Set<string>(),
    netLag = 0,
  } = options;
  const calls: Call[] = [];
  const pages = new Map<string, Page>();
  const page = (session: string): Page => {
    const known = pages.get(session) ?? { now: true, next: true, net: true, stale: 0, asking: [] };
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
    if (target.now !== target.next) target.stale = netLag;
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
      if (method === 'Runtime.evaluate' && params['expression'] === NETWORK_PROBE) {
        const target = page(sessionId);
        if (target.stale > 0) target.stale -= 1;
        else target.net = target.now;
        const value = target.net ? 'reached' : 'refused';
        if (target.net)
          emit('Network.requestWillBeSent', {
            request: { method: 'HEAD', url: `http://app.test${NETWORK_PROBE_PATH}` },
          });
        return Promise.resolve({ result: { result: { type: 'string', value } } });
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
