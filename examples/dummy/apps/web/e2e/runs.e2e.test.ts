/**
 * e2e — the run console, in a real browser against `x dev`: a member connects a site, starts a
 * run, WATCHES its events arrive over the page's one socket with no reload, answers the code the
 * site asks for, and sees the run resume and finish.
 *
 * Everything between the click and the last row is another process's work: the worker claims the
 * job, the scrape waits on the stored event bus with its (recorded) browser open, and each
 * `run_events` row reaches this tab as a live-query patch. The verdict is the RENDERED page,
 * read by `data-*` — never a store, and never words a locale would change.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ISLAND_FAILED_ATTRIBUTE, ISLAND_MOUNTED_ATTRIBUTE } from '@ultimat3/render';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { readFlag, readText } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import { acceptanceBrowser, fail, noBrowser, signInAs, startPostly } from './fixtures/postly';

/** A marker a full page load would lose: the proof that what follows happened without a reload. */
const MARK = 'window.__runConsoleTab = "kept"';
const MARKED = 'window.__runConsoleTab === "kept"';

const consoleMounted = `(() => {
  const island = document.querySelector('[data-x-island*="run-console"]');
  if (!island) return false;
  const failed = island.getAttribute('${ISLAND_FAILED_ATTRIBUTE}');
  return failed ? 'the run console failed to mount: ' + failed : island.hasAttribute('${ISLAND_MOUNTED_ATTRIBUTE}');
})()`;

/** Type into a field the way a person does: the value, then the event Solid listens for. */
const type = (selector: string, value: string): string => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const submit = (selector: string): string => `(() => {
  const form = document.querySelector(${JSON.stringify(selector)});
  if (!form) return false;
  form.requestSubmit();
  return true;
})()`;

const click = (selector: string): string => `(() => {
  const control = document.querySelector(${JSON.stringify(selector)});
  if (!control) return false;
  control.click();
  return true;
})()`;

// Parenthesised: `a ?? null === 'done'` is `a ?? (null === 'done')`, which any state satisfies.
const runState = `(document.querySelector('[data-role="run"]')?.dataset.state ?? null)`;
const eventKinds = `[...document.querySelectorAll('[data-role="run-events"] li')].map((row) => row.dataset.kind).join(',')`;
const eventSeqs = `[...document.querySelectorAll('[data-role="run-events"] li')].map((row) => row.dataset.seq).join(',')`;

const act = async (tab: E2eTab, expression: string, what: string): Promise<void> => {
  if (!(await readFlag(tab, expression))) fail(`could not ${what}`);
};

describe.skipIf(noBrowser)('the run console', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(async () => {
    app = await startPostly('dev');
    browser = await acceptanceBrowser();
    await signInAs(browser.session, app, 'ada');
    tab = await browser.session.newTab();
    await tab.goto(`${app.base}/runs`);
    await tab.waitFor(consoleMounted, 'the run console to mount');
    const mounted = await tab.evaluate(consoleMounted);
    if (typeof mounted === 'string') fail(mounted);
    await tab.evaluate(MARK);
  }, 240_000);

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  });

  test('a member with no connection connects a site, and the picker takes its place', async () => {
    await tab.waitFor(
      `document.querySelector('[data-role="connect"]') !== null`,
      'the connect form',
    );
    await act(tab, type('[data-role="connect"] input:not([type="password"])', 'Ledger'), 'name it');
    const secret = 'correct horse battery staple';
    await act(tab, type('[data-role="connect"] input[type="password"]', secret), 'type the secret');
    await act(tab, submit('[data-role="connect"]'), 'submit the connect form');

    await tab.waitFor(`document.querySelector('#run-start') !== null`, 'the start control');
    // The credential went to the server and nowhere on the page.
    expect(await readText(tab, 'document.body.innerHTML')).not.toContain(secret);
  }, 60_000);

  test('a started run shows its first event arriving, with no reload', async () => {
    await act(tab, click('#run-start'), 'click start');

    await tab.waitFor(`${runState} === 'awaiting'`, 'the run to reach its prompt');
    // The first event is seq 1 — the one a reader asking for `seq > 0` over a 0-based run lost.
    expect(await readText(tab, eventSeqs)).toBe('1');
    expect(await readText(tab, eventKinds)).toBe('prompt');
    expect(await readFlag(tab, MARKED)).toBe(true);
  }, 60_000);

  test('answering the prompt resumes the run, and its remaining events arrive in order', async () => {
    await act(tab, type('[data-role="prompt"] input', '482913'), 'type the code');
    await act(tab, submit('[data-role="prompt"]'), 'send the code');

    await tab.waitFor(`${runState} === 'done'`, 'the run to finish');
    expect(await readText(tab, eventSeqs)).toBe('1,2,3,4,5');
    expect(await readText(tab, eventKinds)).toBe('prompt,answered,navigated,extracted,done');
    // The same document throughout: every row above arrived over the socket.
    expect(await readFlag(tab, MARKED)).toBe(true);
    // A finished run has nothing to answer and nothing to cancel.
    expect(await readFlag(tab, `document.querySelector('[data-role="prompt"]')`)).toBe(false);
    // What it used arrives once the queue settled it — one more row over the same socket, drawn
    // as its own block and never as a step of the run.
    await tab.waitFor(
      `document.querySelector('[data-role="run-usage"]') !== null`,
      'what the run used',
    );
    expect(await readText(tab, eventSeqs)).toBe('1,2,3,4,5');
  }, 60_000);
});
