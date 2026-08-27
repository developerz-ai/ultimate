// One responsibility: `E2eBrowserPage` over a raw CDP connection — attach a tab, navigate,
// evaluate, click, and set the browser's offline condition. Launching is `cdp-launch.ts` and the
// wire is `cdp-connection.ts`.
//
// FIVE methods, which is the whole reason this exists next to `@ultimat3/scraping` rather than
// through it: `ScrapePage` is a full scraping surface whose intended implementation is
// `puppeteer-core`, and an e2e driver needs none of it.

import { assert } from '@ultimat3/core';
import type { CdpConnection } from './cdp-connection';
import { CdpCallFailedError } from './cdp-errors';
import type { E2eBrowserPage } from './e2e-page';

/** `Runtime.evaluate`'s answer, unwrapped. Every field here is somebody else's JSON. */
const evaluated = (result: Record<string, unknown> | undefined): unknown => {
  const thrown = result?.['exceptionDetails'];
  if (typeof thrown === 'object' && thrown !== null) {
    const text = (thrown as Record<string, unknown>)['text'];
    throw new CdpCallFailedError({
      method: 'Runtime.evaluate',
      detail: typeof text === 'string' ? text : 'the expression threw in the page',
    });
  }
  const remote = result?.['result'];
  if (typeof remote !== 'object' || remote === null) return undefined;
  return (remote as Record<string, unknown>)['value'];
};

export interface CdpE2ePageOptions {
  readonly connection: CdpConnection;
  /**
   * How long a navigation's load event may take. Distinct from the connection's per-call deadline:
   * `Page.navigate` ANSWERS as soon as the navigation is committed, so the wait for the load event
   * is a second budget and is the one an app makes long.
   */
  readonly loadTimeoutMs: number;
}

/**
 * Attach a fresh tab and give back the page.
 *
 * `flatten: true` is not optional: without it every page call has to be wrapped in
 * `Target.sendMessageToTarget` and the answers arrive as nested strings. Flattened, a `sessionId`
 * on the frame is the whole of it, which is what keeps `cdp-connection.ts` a single map.
 */
export async function cdpE2ePage(options: CdpE2ePageOptions): Promise<E2eBrowserPage> {
  const send = options.connection.send.bind(options.connection);
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.['targetId'];
  assert(
    typeof targetId === 'string',
    'the browser created a tab and answered no targetId',
    'check the Chrome version supports Target.createTarget — every build since 60 does',
  );
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.['sessionId'];
  assert(
    typeof sessionId === 'string',
    'the browser attached to the tab and answered no sessionId',
    'check the Chrome version supports Target.attachToTarget with flatten: true — every build since 79 does',
  );

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  // Enabled at attach rather than inside `offline()`, because `Network.emulateNetworkConditions`
  // is silently ignored on a session whose Network domain was never enabled — the exact shape of
  // an `offline()` that does nothing while the assertion after it reads as proof.
  await send('Network.enable', {}, sessionId);

  // `url()` is SYNCHRONOUS on the port, and CDP has no synchronous read — so the last committed
  // url is tracked here. Seeded with the tab's own starting url rather than '' so a `reload()`
  // before any `goto()` navigates somewhere real.
  let current = 'about:blank';

  const evaluate = async (expression: string): Promise<unknown> => {
    const answer = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return evaluated(answer.result);
  };

  return {
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
      // what should fail.
      await evaluate(`(() => new Promise((resolve) => {
        if (document.readyState === 'complete') { resolve(true); return; }
        const done = () => resolve(true);
        addEventListener('load', done, { once: true });
        setTimeout(done, ${String(options.loadTimeoutMs)});
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
    async offline(enabled: boolean): Promise<void> {
      // `-1` is CDP's "no throttling" for both throughputs. Passing 0 would be a browser that can
      // never transfer a byte, which is a different failure wearing the same name.
      await send(
        'Network.emulateNetworkConditions',
        { offline: enabled, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        sessionId,
      );
    },
  };
}
