// Route-presented modals in a real Chrome, through the real pipeline under an enforced CSP: a link
// to a `navigation: 'modal'` page opens it OVER the page on screen, addressed by the hash
// (`/runs#/runs/new`) — the page beneath keeps its document and its islands; Escape, Back and the
// page's own Cancel close it and give focus back; a reload or a pasted URL reopens it; a stale hash
// is just the page; a form inside posts once, re-renders in place on a refusal, and on success
// closes onto the refreshed page or lands where the server redirected. Scripting off, the same link
// is the whole page.
//
//   bun test packages/cli/e2e/client-navigation-modal.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import { currentTab, noBrowser, TIMEOUT_MS, useBrowser } from './client-navigation-fixture';
import { base, count, ran, state } from './client-navigation-modal-fixture';

const read = (expression: string): Promise<unknown> => currentTab().evaluate(expression);
const waitFor = (expression: string, what: string): Promise<void> =>
  currentTab().waitFor(expression, what);
const DIALOG = 'document.querySelector("dialog[data-x-modal]")';
const MARK = 'window.__kept = "same-document"';
const sameDocument = (): Promise<unknown> => read('window.__kept === "same-document"');
const at = (): Promise<unknown> => read('location.pathname + location.search + location.hash');
const opened = (title: string): Promise<void> =>
  waitFor(
    `${DIALOG}?.open === true && ${DIALOG}.querySelector("h1")?.textContent === ${JSON.stringify(title)}`,
    `the ${title} modal`,
  );
const closed = (): Promise<void> => waitFor(`${DIALOG} === null`, 'the modal closed');
/** Escape, as the browser raises it: `cancel` first, then — if nobody took it — `close`. */
const pressEscape = (): Promise<unknown> =>
  read(
    `(() => { const d = ${DIALOG}; if (typeof d.requestClose === 'function') d.requestClose(); else d.dispatchEvent(new Event('cancel', { cancelable: true })); })()`,
  );

/** A fresh `/runs` (or `/runs#…`), router started, islands up, marked. */
async function start(path = '/runs'): Promise<void> {
  ran.length = 0;
  await currentTab().goto(`${base}${path}`);
  await waitFor('window.__xNavigation !== undefined', 'the router to start');
  await waitFor('document.querySelector("[data-x-mounted]") !== null', 'the islands to mount');
  await read(MARK);
  // What the load itself ran stays for a test that opens a modal from the URL to read.
  if (!path.includes('#')) ran.length = 0;
}

async function openNew(): Promise<void> {
  await read('document.getElementById("new").focus()');
  await read('document.getElementById("new").click()');
  await opened('New run');
}

describe.skipIf(noBrowser)('client navigation · route-presented modals', () => {
  useBrowser();

  test(
    'a link to a modal route opens it over the page: the hash addresses it, the page stays live',
    async () => {
      await start();
      await openNew();
      expect(await at()).toBe('/runs#/runs/new');
      expect(await sameDocument()).toBe(true);
      expect(count('GET /runs/new soft')).toBe(1);
      expect(count('GET /runs soft')).toBe(0);
      // The page beneath: its island still mounted, its content still there, inert behind the modal.
      expect(await read('(window.__disposed || []).length')).toBe(0);
      expect(await read('document.getElementById("count") !== null')).toBe(true);
      await waitFor('(window.__mounts || []).includes("form")', "the modal's own island");
      // Named by its heading, modal to assistive tech, focus inside, the tab titled after it.
      expect(
        await read(
          `document.getElementById(${DIALOG}.getAttribute('aria-labelledby'))?.textContent`,
        ),
      ).toBe('New run');
      expect(await read(`${DIALOG}.matches(':modal')`)).toBe(true);
      expect(await read(`${DIALOG}.contains(document.activeElement)`)).toBe(true);
      expect(await read('document.title')).toBe('New run');
      // Links and the action-less form resolve against the MODAL's URL, as on its own page.
      expect(await read('document.getElementById("create").action')).toBe(`${base}/runs/new`);
      expect(await read('document.getElementById("step").href')).toBe(`${base}/runs/new?step=2`);
    },
    TIMEOUT_MS,
  );

  test(
    'Escape closes it: the hash goes, the title and focus come back, nothing is fetched',
    async () => {
      await start();
      await openNew();
      await pressEscape();
      await closed();
      await waitFor('location.hash === ""', 'the hash cleared');
      expect(await at()).toBe('/runs');
      expect(await read('document.title')).toBe('Runs');
      expect(await read('document.activeElement?.id')).toBe('new');
      expect(await read('(window.__disposed || []).includes("form")')).toBe(true);
      expect(await read('(window.__disposed || []).includes("list")')).toBe(false);
      expect(count('GET /runs soft')).toBe(0);
      expect(await sameDocument()).toBe(true);
      // Escape was Back through the entry the router pushed: Forward reopens the same modal.
      await read('history.forward()');
      await opened('New run');
      expect(await at()).toBe('/runs#/runs/new');
    },
    TIMEOUT_MS,
  );

  test(
    "Back closes it, and the page's own link back (Cancel) closes it without a fetch",
    async () => {
      await start();
      await openNew();
      await read('history.back()');
      await closed();
      expect(await at()).toBe('/runs');
      await openNew();
      await read('document.getElementById("cancel").click()');
      await closed();
      expect(await at()).toBe('/runs');
      expect(count('GET /runs soft')).toBe(0);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'a reload or a pasted URL reopens it over its page; closing that drops the hash in place',
    async () => {
      // From another document, so the address is a real load rather than a fragment change.
      await currentTab().goto(`${base}/about`);
      await start('/runs#/runs/new');
      await opened('New run');
      expect(count('GET /runs full')).toBe(1);
      expect(count('GET /runs/new soft')).toBe(1);
      expect(await read('document.getElementById("count") !== null')).toBe(true);
      const length = await read('history.length');
      await pressEscape();
      await closed();
      // Nothing of the router's beneath it: Back would have left the app, so the hash is replaced.
      expect(await at()).toBe('/runs');
      expect(await read('history.length')).toBe(length);
      await read('location.reload()');
      await waitFor('window.__kept === undefined && window.__xNavigation !== undefined', 'reload');
      expect(await read(DIALOG)).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    'a hash typed over the page opens its modal, and clearing it closes',
    async () => {
      await start();
      await read('location.hash = "#/runs/new"');
      await opened('New run');
      expect(await sameDocument()).toBe(true);
      await read('location.hash = ""');
      await closed();
      expect(await read('document.title')).toBe('Runs');
    },
    TIMEOUT_MS,
  );

  test(
    'a stale hash is just the page: not a modal, not found — dropped, never an error',
    async () => {
      for (const stale of ['#/about', '#/nowhere/at/all', '#/runs/1']) {
        await currentTab().goto(`${base}/about`);
        await start(`/runs${stale}`);
        await waitFor('location.hash === ""', `${stale} dropped`);
        expect(await read(DIALOG)).toBeNull();
        expect(await read('document.title')).toBe('Runs');
        expect(await sameDocument()).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  test(
    'one modal at a time: a deeper step replaces the content in the same dialog, Back steps out',
    async () => {
      await start();
      await openNew();
      await read('document.getElementById("advanced").click()');
      await opened('Advanced');
      expect(await read('document.querySelectorAll("dialog[data-x-modal]").length')).toBe(1);
      expect(await at()).toBe('/runs#/runs/new/advanced');
      expect(await read('(window.__disposed || []).includes("form")')).toBe(true);
      await read('history.back()');
      await opened('New run');
      expect(await at()).toBe('/runs#/runs/new');
      await read('document.getElementById("step").click()');
      await opened('New run, step 2');
      expect(await at()).toBe('/runs#/runs/new?step=2');
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'a refused submit re-renders inside the modal: one POST, the address unchanged',
    async () => {
      await start();
      await openNew();
      await read('document.getElementById("submit").click()');
      await waitFor('document.getElementById("error") !== null', 'the refusal');
      expect(await read(`${DIALOG}.contains(document.getElementById("error"))`)).toBe(true);
      expect(await at()).toBe('/runs#/runs/new');
      expect(count('POST /runs/new soft')).toBe(1);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "a submit redirected to the page beneath closes the modal and refreshes that page's content",
    async () => {
      state.runs = 0;
      await start();
      const length = await read('history.length');
      await openNew();
      await read('document.getElementById("name").value = "nightly"');
      await read('document.getElementById("submit").click()');
      await closed();
      await waitFor('document.getElementById("count")?.textContent === "1 runs"', 'the refresh');
      expect(await at()).toBe('/runs');
      expect(count('POST /runs/new soft')).toBe(1);
      expect(count('GET /runs soft')).toBe(1);
      expect(await sameDocument()).toBe(true);
      // Out through Back: the spent form's entry is not left under the page to reopen.
      await waitFor(`history.length === ${String(length)} + 1`, 'the entries');
      expect(await read('history.state?.__x?.modal')).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    'a submit redirected elsewhere lands there, in place of the modal’s entry',
    async () => {
      await start();
      await openNew();
      await read('document.getElementById("name").value = "detail"');
      await read('document.getElementById("submit").click()');
      await waitFor('document.title === "Run 1"', 'the run page');
      expect(await read(DIALOG)).toBeNull();
      expect(await at()).toBe('/runs/1');
      expect(count('POST /runs/new soft')).toBe(1);
      expect(await sameDocument()).toBe(true);
      await read('history.back()');
      await waitFor('document.title === "Runs" && location.hash === ""', 'Back to the list');
      expect(await read(DIALOG)).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    'a confirmation route: confirm posts once and closes onto the list; a dialog form keeps it',
    async () => {
      state.runs = 3;
      await start();
      await read('document.getElementById("revoke").click()');
      await opened('Revoke run 7?');
      // `<form method="dialog">`: the browser closes the dialog, and the URL follows.
      await read('document.getElementById("keep").click()');
      await closed();
      await waitFor('location.hash === ""', 'the hash cleared');
      expect(count('POST /runs/7/revoke soft')).toBe(0);
      await read('document.getElementById("revoke").click()');
      await opened('Revoke run 7?');
      await read('document.getElementById("confirm").click()');
      await closed();
      await waitFor('document.getElementById("count")?.textContent === "2 runs"', 'the refresh');
      expect(count('POST /runs/7/revoke soft')).toBe(1);
      expect(await at()).toBe('/runs');
    },
    TIMEOUT_MS,
  );

  test(
    'from code: openModal and closeModal as a link and Escape, refresh in place and where scrolled',
    async () => {
      state.runs = 4;
      await start();
      await read('window.__xNavigation.openModal("/runs/new")');
      await opened('New run');
      expect(await at()).toBe('/runs#/runs/new');
      await read('window.__xNavigation.closeModal()');
      await closed();
      expect(await at()).toBe('/runs');
      // A modal-less address opens nothing, as a stale hash does.
      await read('window.__xNavigation.openModal("/about")');
      expect(await read(DIALOG)).toBeNull();
      expect(await at()).toBe('/runs');
      // Through the CSSOM on <html>, which every swap keeps: an inline <style> is refused by the CSP.
      await read('document.documentElement.style.minHeight = "6000px"');
      await read('scrollTo(0, 900)');
      state.runs = 5;
      await read('window.__xNavigation.refresh()');
      await waitFor('document.getElementById("count")?.textContent === "5 runs"', 'the refresh');
      expect(await read('scrollY')).toBe(900);
      expect(count('GET /runs soft')).toBe(1);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'scripting off: the same link is the whole page, and its form posts natively',
    async () => {
      const tab = currentTab();
      await tab.scripting(false);
      try {
        await tab.evaluate(`location.href = ${JSON.stringify(`${base}/runs`)}`);
        await tab.waitFor(
          'location.pathname === "/runs" && document.readyState === "complete"',
          'runs',
        );
        await tab.click('#new');
        await tab.waitFor(
          'location.pathname === "/runs/new" && document.readyState === "complete"',
          'the whole page',
        );
        expect(await tab.evaluate(DIALOG)).toBeNull();
        expect(await tab.evaluate('document.querySelector("main h1").textContent')).toBe('New run');
      } finally {
        await tab.scripting(true);
      }
    },
    TIMEOUT_MS,
  );
});
