/**
 * e2e — plan 101 slice 41, done-when: an island shows a model's tokens BEFORE the final answer.
 * `/posts/<id>`'s summary island reads `summarize` (an `llm()`, which declares `stream`) through the
 * typed client's `.stream()`: POST with `accept: text/event-stream`, each `chunk` frame appended as
 * it is read. The app runs with no model provider, so the page's stream is answered by an init
 * script that HOLDS the rest of the body after the first token: the first token on screen while
 * the answer is still unsent is the claim, and a client that buffered would show nothing until the
 * hold lets go. The server half — `llm()`'s own route streaming a held provider — is
 * `packages/ai/src/llm-route-stream.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_GOTO_MS, E2E_TAB_OPEN_MS } from '@ultimat3/testing';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  ACCEPTANCE_CLOSE_MS,
  ACCEPTANCE_OPEN_MS,
  acceptanceBrowser,
  noBrowser,
  POSTS,
  SIGN_IN_MS,
  signInAs,
  startPostly,
} from './fixtures/postly';

/** Set by the test to let the held body go. */
const RELEASE = 'e2eSummaryRelease';
/** Every streamed request the page made: `accept` and path, as the script saw them. */
const SEEN = 'e2eSummarySeen';

/**
 * Answers a POST asking for `text/event-stream` with one `chunk`, then waits for `RELEASE` before
 * the second chunk and the `done` frame. Everything else goes to the network untouched.
 */
const HOLD_SCRIPT = `(() => {
  const realFetch = globalThis.fetch;
  globalThis[${JSON.stringify(SEEN)}] = [];
  globalThis.fetch = function (input, init) {
    const accept = new Headers(init?.headers).get('accept') ?? '';
    if (String(init?.method).toUpperCase() !== 'POST' || !accept.includes('text/event-stream')) {
      return realFetch.call(this, input, init);
    }
    const url = typeof input === 'string' ? input : input.url;
    globalThis[${JSON.stringify(SEEN)}].push({ accept, path: new URL(url, location.href).pathname });
    const encoder = new TextEncoder();
    const frame = (event, data) => encoder.encode('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n');
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(frame('chunk', { type: 'text', text: 'Tenancy ' }));
        while (globalThis[${JSON.stringify(RELEASE)}] !== true) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        controller.enqueue(frame('chunk', { type: 'text', text: 'is a column.' }));
        controller.enqueue(frame('done', { summary: 'Every row names its org.', tags: [] }));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
})();`;

/** The island's button: the one right before the region the tokens land in. */
const BUTTON = 'button:has(+ [data-role="summary"])';

const OUTPUT = `document.querySelector('[data-role="summary"]')?.textContent ?? ''`;

describe.skipIf(noBrowser)('a streamed summary', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startPostly();
      browser = await acceptanceBrowser(HOLD_SCRIPT);
      await signInAs(browser.session, app, 'ada');
      tab = await browser.session.newTab();
      await tab.goto(`${app.base}/posts/${POSTS.tenancy.id}`);
    },
    ACCEPTANCE_OPEN_MS + SIGN_IN_MS + E2E_TAB_OPEN_MS + E2E_GOTO_MS,
  );

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS + DEFAULT_CDP_TIMEOUT_MS);

  test('the first token is on screen while the answer is still held', async () => {
    // The island enables the button the server rendered disabled: it has mounted.
    await tab.waitFor(
      `document.querySelector('${BUTTON}')?.disabled === false`,
      'the island mounting',
    );
    await tab.click(BUTTON);
    await tab.waitFor(`${OUTPUT} === 'Tenancy '`, 'the first token, before the rest is sent');
    // Still held: the final answer cannot be here yet.
    expect(await tab.evaluate(OUTPUT)).toBe('Tenancy ');

    await tab.evaluate(`globalThis.${RELEASE} = true`);
    await tab.waitFor(
      `${OUTPUT} === 'Every row names its org.'`,
      'the validated answer replacing the tokens',
    );
    const seen = JSON.parse(String(await tab.evaluate(`JSON.stringify(globalThis.${SEEN})`))) as {
      accept: string;
      path: string;
    }[];
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accept).toBe('text/event-stream');
  }, 60_000);
});
