// One responsibility: one TAB over a raw CDP session — navigate, reload, evaluate, click, wait. The
// session (`cdp-e2e-session.ts`) attaches it and owns everything browser-wide: the network
// condition, the init scripts, the socket and request log. Launching is `cdp-launch.ts` and the
// wire is `cdp-connection.ts`.
//
// FIVE methods, which is the whole reason this exists next to `@ultimat3/scraping` rather than
// through it: `ScrapePage` is a full scraping surface whose intended implementation is
// `puppeteer-core`, and an e2e driver needs none of it.

import type { CdpConnection } from './cdp-connection';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import type { E2eBrowserPage } from './e2e-page';

/** What the page threw, when `Runtime.evaluate` answered with an exception rather than a value. */
const thrownIn = (result: Record<string, unknown> | undefined): string | undefined => {
  const thrown = result?.['exceptionDetails'];
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  const text = (thrown as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : 'the expression threw in the page';
};

/** `Runtime.evaluate`'s answer, unwrapped. Every field here is somebody else's JSON. */
const evaluated = (result: Record<string, unknown> | undefined): unknown => {
  const threw = thrownIn(result);
  if (threw !== undefined) {
    throw new CdpCallFailedError({ method: 'Runtime.evaluate', detail: threw });
  }
  const remote = result?.['result'];
  if (typeof remote !== 'object' || remote === null) return undefined;
  return (remote as Record<string, unknown>)['value'];
};

/** One tab: the port the driver drives, plus what a multi-tab acceptance suite asks of one. */
export interface E2eTab extends E2eBrowserPage {
  readonly targetId: string;
  /** Browser-wide, like the switch it models: every tab AND every worker goes with it. */
  offline(enabled: boolean): Promise<void>;
  /** Reload and wait for the load, at the url the tab already had. */
  reload(): Promise<void>;
  /** Poll `expression` in the page until it is truthy, or refuse naming `what`. */
  waitFor(expression: string, what: string, timeoutMs?: number): Promise<void>;
  /** The IndexedDB databases this tab's origin holds, by name, sorted. */
  indexedDbNames(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface CdpE2eTabOptions {
  readonly connection: CdpConnection;
  /** The attached tab's flattened session — every page call carries it. */
  readonly sessionId: string;
  readonly targetId: string;
  /**
   * How long a navigation's load event may take. Distinct from the connection's per-call deadline:
   * `Page.navigate` ANSWERS as soon as the navigation is committed, so the wait for the load event
   * is a second budget and is the one an app makes long.
   */
  readonly loadTimeoutMs: number;
  /** The session's browser-wide switch, which `offline()` forwards to. */
  readonly offline: (enabled: boolean) => Promise<void>;
}

const POLL_MS = 100;

/** A tab over a session the caller has already attached and enabled (`cdp-e2e-session.ts`). */
export function cdpE2eTab(options: CdpE2eTabOptions): E2eTab {
  const send = options.connection.send.bind(options.connection);
  const { sessionId } = options;

  // `url()` is SYNCHRONOUS on the port, and CDP has no synchronous read — so the last committed
  // url is tracked here. Seeded with the tab's own starting url rather than '' so a `reload()`
  // before any `goto()` navigates somewhere real.
  let current = 'about:blank';

  const evaluateRaw = (expression: string) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  const evaluate = async (expression: string): Promise<unknown> =>
    evaluated((await evaluateRaw(expression)).result);

  // A poll that THROWS is a poll that does not hold yet, not a refusal: a click that navigates
  // leaves the next poll reading a document whose `<body>` is not parsed, and
  // `document.body.textContent` throws there once and holds a poll later. The last throw is kept
  // and named at the deadline, so an expression that can never evaluate still says why.
  const waitFor = async (expression: string, what: string, timeoutMs = options.loadTimeoutMs) => {
    // Only the PAGE's throw is swallowed: a connection that died still refuses at once.
    let threw: string | undefined;
    for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
      const answer = (await evaluateRaw(`Boolean(${expression})`)).result;
      threw = thrownIn(answer);
      if (threw === undefined && evaluated(answer) === true) return;
      await Bun.sleep(POLL_MS);
    }
    const last = threw === undefined ? '' : `, and its last poll threw: ${threw}`;
    throw new CdpTimeoutError({ method: `waitFor(${what})${last}`, timeoutMs });
  };

  const tab: E2eTab = {
    targetId: options.targetId,
    url: () => current,
    async goto(url: string): Promise<unknown> {
      // **The load EVENT is the signal, not the reply.** Chrome drops `Page.navigate`'s own reply
      // whenever the navigation swaps the render process — measured on Chrome 150 against a local
      // server: the page loads, the server is hit, a later `Runtime.evaluate` answers `document
      // .title` from the new document, and the navigate frame never comes back at all. Awaiting
      // the reply therefore waited out the full deadline on the most ordinary navigation there is,
      // `about:blank` → `http://localhost:<port>/`. So the waiter is registered BEFORE the send,
      // and the reply is raced against it rather than depended on.
      const loaded = options.connection.once(
        'Page.loadEventFired',
        sessionId,
        options.loadTimeoutMs,
      );
      // A dropped reply is expected, so its rejection is answered rather than thrown: what the
      // reply is still worth reading for is `errorText`, which is the ONLY place a refused
      // navigation is named — an unreachable host loads no page and fires no load event.
      const answered = send('Page.navigate', { url }, sessionId).then(
        (answer) => {
          const failed = answer.result?.['errorText'];
          return typeof failed === 'string' && failed !== '' ? failed : undefined;
        },
        () => undefined,
      );
      const failed = await Promise.race([loaded.then(() => undefined), answered]);
      if (failed !== undefined) {
        throw new CdpCallFailedError({ method: `Page.navigate to ${url}`, detail: failed });
      }
      current = url;
      // The load event may already have fired before the waiter was registered on a same-process
      // navigation, and `answered` can win the race on one too. So the document is asked directly:
      // a `readyState` that is already `complete` resolves at once, and the deadline resolves
      // rather than throwing — a slow page is the app's business, and the assertion after this is
      // what should fail. HALF the budget, because the budget is also the connection's per-call
      // deadline: a page timer of the full budget raced that deadline and lost, reporting a page
      // that never fired `load` as "Runtime.evaluate did not answer" instead.
      await evaluate(`(() => new Promise((resolve) => {
        if (document.readyState === 'complete') { resolve(true); return; }
        const done = () => resolve(true);
        addEventListener('load', done, { once: true });
        setTimeout(done, ${String(Math.floor(options.loadTimeoutMs / 2))});
      }))()`);
      // The app may have redirected, so the committed url is re-read rather than assumed.
      const settled = await evaluate('location.href');
      if (typeof settled === 'string' && settled !== '') current = settled;
      return undefined;
    },
    evaluate,
    async click(selector: string): Promise<void> {
      // In-page rather than a synthesised `Input.dispatchMouseEvent`: the port takes a SELECTOR,
      // and turning one into coordinates means a box model read, a scroll and a hit test — three
      // more CDP calls, each with its own way to be wrong about an element the page can click.
      const clicked = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (clicked !== true) {
        throw new CdpCallFailedError({
          method: `click(${selector})`,
          detail: 'no element in the page matches that selector',
        });
      }
    },
    offline: (enabled: boolean) => options.offline(enabled),
    async reload(): Promise<void> {
      const at = current;
      // Reload is a navigation to the url the tab already has — the one wait the port proves.
      await tab.goto(at);
    },
    waitFor,
    async indexedDbNames(): Promise<readonly string[]> {
      const names = await evaluate(
        '(async () => (await indexedDB.databases()).map((db) => db.name ?? "").sort())()',
      );
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === 'string')
        : [];
    },
    async close(): Promise<void> {
      await send('Target.closeTarget', { targetId: options.targetId });
    },
  };
  return tab;
}
