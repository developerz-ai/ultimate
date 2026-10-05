// One responsibility: the BROWSER half of the e2e driver — every target auto-attached at browser
// level, so a second tab, a SharedWorker, a dedicated worker and a service worker are all watched
// from their first byte; the offline switch, the init scripts, and the log of every WebSocket and
// request the browser made. A tab is `cdp-e2e-page.ts`'s; this file decides what every tab shares.

import type { CdpConnection } from './cdp-connection';
import type { E2eTab } from './cdp-e2e-page';
import { cdpE2eTab } from './cdp-e2e-page';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import { offlineScripts } from './cdp-offline-script';

export interface E2eSession {
  /** A new tab in the same profile — same cookies, same origin storage, same SharedWorker. */
  newTab(): Promise<E2eTab>;
  /** Runs in every page before its own scripts, in tabs open now and tabs opened later. */
  addInitScript(source: string): Promise<void>;
  /** Cut or restore the network for every page AND every worker, including ones attached later. */
  offline(enabled: boolean): Promise<void>;
  setCookie(url: string, name: string, value: string): Promise<void>;
  /** Every WebSocket url the browser opened, in any realm — page, dedicated, shared or service worker. */
  sockets(): readonly string[];
  /** Every request the browser sent, `METHOD url`, in order. */
  requests(): readonly string[];
}

export interface CdpE2eSessionOptions {
  readonly connection: CdpConnection;
  /** The load budget every tab's `goto` waits on, and how long a new tab may take to attach. */
  readonly loadTimeoutMs: number;
  /**
   * Sent as `Accept-Language` by every page and worker. The e2e step pins the app's default
   * locale here, so a `site/` page negotiates the same language on every box — never the one the
   * CI runner's Chrome was installed with.
   */
  readonly acceptLanguage?: string | undefined;
}

/** What a page reports to its own code — the state a test's next `fetch` runs under. */
const ON_LINE = 'navigator.onLine';

/**
 * Answers `true` at once when the page already reads `online`, else on the `online`/`offline`
 * event that flips it. The read and the `addEventListener` run in ONE task, so the event cannot
 * land between them. `false` only when the event came and the state still disagrees: ask again.
 */
const readsOnLine = (online: boolean): string => {
  const reads = `${ON_LINE} === ${String(online)}`;
  const flip = online ? 'online' : 'offline';
  return `${reads} || new Promise((resolve) => addEventListener('${flip}', () => resolve(${reads}), { once: true }))`;
};

const member = (from: unknown, key: string): unknown =>
  typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;

const field = (from: unknown, key: string): string | undefined => {
  const value = member(from, key);
  return typeof value === 'string' ? value : undefined;
};

/**
 * Start watching the browser. Targets are attached PAUSED (`waitForDebuggerOnStart: true`) and
 * released only once their network domain is ENABLED, in dispatch order — a SharedWorker opens its
 * socket at start-up, so a target configured any later than that is a socket nothing ever counted.
 * Released with `Runtime.runIfWaitingForDebugger` whatever happens and without waiting for any
 * answer, or a page that registered a worker never becomes controlled.
 */
export async function cdpE2eSession(options: CdpE2eSessionOptions): Promise<E2eSession> {
  const { connection } = options;
  const send = connection.send.bind(connection);
  const sessions = new Set<string>();
  const pages = new Map<string, string>(); // targetId → sessionId
  // targetId → the `newTab()` waiting for that tab to be published.
  const published = new Map<string, (session: string) => void>();
  const scripts: string[] = [];
  const sockets: string[] = [];
  const requests: string[] = [];
  let cut = false;

  // `-1` is CDP's "no throttling" for both throughputs; 0 would be a browser that can never
  // transfer a byte, which is a different failure wearing the same name.
  const pageSessions = new Set<string>();
  const onLineScripts = offlineScripts(send);
  const condition = (session: string): Promise<unknown> =>
    send(
      'Network.emulateNetworkConditions',
      { offline: cut, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      session,
    );

  connection.on('Network.webSocketCreated', (params) => {
    sockets.push(field(params, 'url') ?? '');
  });
  connection.on('Network.requestWillBeSent', (params) => {
    const request = params['request'];
    requests.push(`${field(request, 'method') ?? '?'} ${field(request, 'url') ?? ''}`);
  });
  connection.on('Target.attachedToTarget', (params) => {
    const session = field(params, 'sessionId');
    if (session === undefined) return;
    const info = params['targetInfo'];
    const type = field(info, 'type');
    sessions.add(session);
    void (async () => {
      // Every configuration call is SENT before the release and none is AWAITED before it. A
      // session dispatches in order, so the target is still configured before its first byte runs —
      // but a paused target may answer nothing until it is released: measured in a full `x verify`,
      // a SharedWorker's `Network.enable` went unanswered for the whole 30 s deadline, the worker
      // stayed paused that long, and the shared gate page stalled behind it. Awaiting the answers
      // before releasing was a deadlock with a timeout for an exit.
      //
      // `Network.enable` first: `emulateNetworkConditions` is silently ignored on a session whose
      // Network domain is off — an `offline()` that does nothing while the assertion after it
      // reads as proof.
      const configured: Promise<unknown>[] = [send('Network.enable', {}, session)];
      if (options.acceptLanguage !== undefined) {
        configured.push(
          send(
            'Network.setExtraHTTPHeaders',
            { headers: { 'accept-language': options.acceptLanguage } },
            session,
          ),
        );
      }
      if (cut) configured.push(condition(session));
      if (type === 'page') {
        configured.push(send('Page.enable', {}, session), send('Runtime.enable', {}, session));
        pageSessions.add(session);
        for (const source of scripts) {
          configured.push(send('Page.addScriptToEvaluateOnNewDocument', { source }, session));
        }
        if (cut) configured.push(onLineScripts.add(session));
        // The page's own workers attach under it UNPAUSED. Measured: paused here, the emitted
        // service worker never took control of its page (`e2e/service-worker.e2e.test.ts` went
        // red), because it is also attached at browser level. A dedicated worker's first request
        // can therefore precede its Network.enable — the SharedWorker, which is what owns the
        // socket, is a browser-level target and IS paused.
        configured.push(
          send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            session,
          ),
        );
      }
      const released = send('Runtime.runIfWaitingForDebugger', {}, session).catch(() => undefined);
      // Settled, not `all`: a target that went away refuses EVERY call, and `all` would leave the
      // refusals after the first as unhandled rejections. It has nothing left to watch.
      const answers = await Promise.allSettled(configured);
      if (answers.some((answer) => answer.status === 'rejected')) sessions.delete(session);
      await released;
      // Published only once RELEASED: a tab handed out while still paused would take its first
      // `goto` into a page that is waiting for a debugger.
      const targetId = field(info, 'targetId');
      if (type === 'page' && targetId !== undefined && sessions.has(session)) {
        pages.set(targetId, session);
        published.get(targetId)?.(session);
      }
    })();
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  /** Settles `true` on `event` from `session` and `false` at `deadline`, whichever is first. */
  const nextEvent = (event: string, session: string, deadline: number) => {
    let heard: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const off = connection.on(event, (_params, on) => {
      if (on === session) heard();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      /** Subscribed when created, so an event that lands before this is awaited still counts. */
      wait: (): Promise<boolean> =>
        Promise.race([
          arrived.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
          }),
        ]),
      close: (): void => {
        off();
        clearTimeout(timer);
      },
    };
  };

  /**
   * Whether one page came to read `navigator.onLine === online` before `deadline`. The page itself
   * says when — the evaluated promise resolves on the event that flips it, `awaitPromise` holds the
   * reply until then — so nothing is polled and nothing sleeps. A navigation destroys the context
   * the promise lived in and refuses the call; the page is asked again in the document that
   * replaces it, once Chrome announces that document's context.
   */
  const pageReads = async (session: string, online: boolean, deadline: number) => {
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      const context = nextEvent('Runtime.executionContextCreated', session, deadline);
      try {
        const answer = await send(
          'Runtime.evaluate',
          { expression: readsOnLine(online), returnByValue: true, awaitPromise: true },
          session,
          remaining,
        );
        const value = member(member(answer.result, 'result'), 'value');
        if (value === true) return true;
        // `false`: the event fired and the state disagrees, so the next ask awaits the next one.
        // Anything else is a page that could not run the read — the same as a refusal, below.
        if (value !== false && !(await context.wait())) return false;
      } catch (error) {
        if (error instanceof CdpTimeoutError) return false;
        if (!(await context.wait())) return false;
      } finally {
        context.close();
      }
    }
  };

  // #572. `offline()` SENDS the condition, and the renderer applies it when it gets to it: a `fetch`
  // on the caller's next line raced that on a slow runner and went through under a switch the test
  // had already thrown. So the switch is thrown when every page READS the state, and not before —
  // never a fixed sleep, which is either too long everywhere or too short on the runner that
  // matters. Bounded by the load budget, because a page mid-navigation answers only once it lands;
  // a page that never reads it is a timeout naming the page, never a resolve the test trusts.
  const confirmed = async (online: boolean): Promise<void> => {
    const deadline = performance.now() + options.loadTimeoutMs;
    const open = [...pageSessions].filter((session) => sessions.has(session));
    const answers = await Promise.all(
      open.map(async (session) => [session, await pageReads(session, online, deadline)] as const),
    );
    const waiting = answers.filter(([, reads]) => !reads).map(([session]) => session);
    if (waiting.length > 0) {
      throw new CdpTimeoutError({
        method: `${ON_LINE} === ${String(online)} in page session ${waiting.join(', ')}`,
        timeoutMs: options.loadTimeoutMs,
      });
    }
  };

  const offline = async (enabled: boolean): Promise<void> => {
    cut = enabled;
    // Sequential, and a session that has gone away is dropped rather than taking the rest down.
    for (const session of [...sessions]) {
      await condition(session).catch(() => sessions.delete(session));
    }
    // And `navigator.onLine` from a new document's first script (`cdp-offline-script.ts`) — the
    // network condition alone reaches a reloaded page only after its scripts have run.
    // A page that is still THERE and refuses is kept and reported once every page has been asked:
    // dropping it meant every later `offline()` skipped that tab in silence. Only a session the
    // loop above just found gone is dropped — a closed tab refuses every call.
    const refused: unknown[] = [];
    for (const session of [...pageSessions]) {
      if (!sessions.has(session)) {
        pageSessions.delete(session);
        continue;
      }
      const toggled = enabled ? onLineScripts.add(session) : onLineScripts.remove(session);
      await toggled.catch((error: unknown) => refused.push(error));
    }
    if (refused.length > 0) throw refused[0];
    await confirmed(!enabled);
  };

  /** The tab's session once it is published — told by the attach itself, never polled for. */
  const attached = (targetId: string): Promise<string> => {
    const session = pages.get(targetId);
    if (session !== undefined) return Promise.resolve(session);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        published.delete(targetId);
        reject(
          new CdpTimeoutError({
            method: `Target.attachedToTarget for tab ${targetId}`,
            timeoutMs: options.loadTimeoutMs,
          }),
        );
      }, options.loadTimeoutMs);
      published.set(targetId, (ready) => {
        clearTimeout(timer);
        published.delete(targetId);
        resolve(ready);
      });
    });
  };

  return {
    async newTab(): Promise<E2eTab> {
      const created = await send('Target.createTarget', { url: 'about:blank' });
      const targetId = field(created.result, 'targetId');
      if (targetId === undefined) {
        throw new CdpCallFailedError({
          method: 'Target.createTarget',
          detail: 'the browser created a tab and answered no targetId',
        });
      }
      const sessionId = await attached(targetId);
      return cdpE2eTab({
        connection,
        sessionId,
        targetId,
        loadTimeoutMs: options.loadTimeoutMs,
        offline,
      });
    },
    async addInitScript(source: string): Promise<void> {
      scripts.push(source);
      // A closed tab refuses every call; it is dropped rather than taking the open tabs down with
      // it, exactly as `offline()` drops one.
      for (const [targetId, session] of [...pages]) {
        await send('Page.addScriptToEvaluateOnNewDocument', { source }, session).catch(() => {
          pages.delete(targetId);
          sessions.delete(session);
          pageSessions.delete(session);
        });
      }
    },
    offline,
    async setCookie(url: string, name: string, value: string): Promise<void> {
      await send('Storage.setCookies', { cookies: [{ name, value, url, path: '/' }] });
    },
    sockets: () => [...sockets],
    requests: () => [...requests],
  };
}
