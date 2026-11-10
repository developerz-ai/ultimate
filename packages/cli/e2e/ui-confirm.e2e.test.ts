// `@ultimat3/ui`'s `ConfirmDialog` in a real Chrome at a phone's width: Enter straight after the
// dialog opens cancels, a backdrop click leaves it open, Esc returns focus to the trigger, a refusal
// keeps it open with focus on the summary, and — with no script on the page at all — the trigger
// opens it and the confirm POSTS. The markup the no-script document serves is the island's own
// render, copied out, so the two halves are one component. Skips with no Chrome, unless
// E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SleepClock } from '@ultimat3/core';
import { findChrome } from '@ultimat3/scraping/cdp';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_BROWSER_OPEN_MS } from '@ultimat3/testing';
import type { ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/confirm.island.tsx';
const VIEWPORT = { width: 390, height: 844 } as const;

/** One dialog that posts natively, one an island runs: refused once, then done. */
const ISLAND = `import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { ConfirmDialog, setSolidRuntime } from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  let asked = 0;
  render(
    () => (
      <div>
        <div id="native">
          <ConfirmDialog
            id="withdraw"
            action="/submit"
            trigger="Withdraw"
            title="Withdraw this post?"
            consequence="Readers lose the page at once."
            confirmLabel="Withdraw post"
            cancelLabel="Cancel"
          >
            <input type="hidden" name="postId" value="p-1" />
          </ConfirmDialog>
        </div>
        <ConfirmDialog
          id="delete"
          trigger="Delete"
          title="Delete this run?"
          consequence="Its logs go with it."
          confirmLabel="Delete run"
          cancelLabel="Cancel"
          onConfirm={() => {
            asked += 1;
            (window as unknown as { __asked: number }).__asked = asked;
            return Promise.resolve(asked === 1 ? 'Only the owner can delete it' : undefined);
          }}
        />
      </div>
    ),
    el,
  );
}
`;

const ERRORS = `<script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script>`;

/** A fixed box in the corner, outside every dialog: a click there lands on the backdrop. */
const CORNER =
  '<div id="corner" style="position:fixed;inset-block-start:0;inset-inline-start:0;inline-size:24px;block-size:24px"></div>';

const islandDocument = (url: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">${ERRORS}</head>
<body>${CORNER}<div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** The same markup with no script anywhere in the document: scripting is simply not there. */
const staticDocument = (markup: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body>${markup}</body></html>`;

const clock: SleepClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  // real-clock: the poll waits on Chrome, another process, which no fake timer moves.
  sleep: (ms) => Bun.sleep(ms),
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const BUILD_MS = 30_000;
const STEP_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + 6 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)('ConfirmDialog in a browser, at 390px', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  const posts: string[] = [];
  let staticMarkup = '';

  const page = () => session?.page ?? expect.unreachable('no browser session');
  const read = async (expression: string): Promise<unknown> => page().evaluate(expression);
  const open = (id: string): Promise<unknown> => read(`document.getElementById('${id}').open`);
  const activeText = (): Promise<unknown> =>
    read('document.activeElement && document.activeElement.textContent');
  /** Polled, never slept: a dialog's state after an input event is the next task's. */
  const until = async (expression: string, what: string): Promise<void> => {
    const started = clock.monotonic();
    while ((await read(expression)) !== true) {
      if (clock.monotonic() - started > STEP_MS)
        expect.unreachable(`timed out waiting for ${what}`);
      await clock.sleep(25);
    }
  };

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-confirm', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST') {
          posts.push(`${path} ${new URLSearchParams(await request.text()).get('postId')}`);
          return new Response('posted', { headers: { 'content-type': 'text/plain' } });
        }
        const asset = bundle.assetAt(path);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        const html = path === '/static' ? staticDocument(staticMarkup) : islandDocument(chunk.url);
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    session = await cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT }).open({
      name: 'ui confirm',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: DEFAULT_CDP_TIMEOUT_MS,
    });
    await page().goto(`http://localhost:${String(server.port)}/`);
    await until('window.__done === true', 'the island to mount');
    staticMarkup = String(await read(`document.getElementById('native').innerHTML`));
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test(
    'mounting threw nothing',
    async () => {
      expect(JSON.parse(String(await read('JSON.stringify(window.__errors)')))).toEqual([]);
    },
    STEP_MS * 3,
  );

  test(
    'opening lands on Cancel, so Enter straight away cancels and posts nothing',
    async () => {
      await page().click('#native button[command="show-modal"]');
      await until(`document.getElementById('withdraw').open === true`, 'the dialog to open');
      expect(await activeText()).toBe('Cancel');
      await page().press('Enter');
      await until(`document.getElementById('withdraw').open === false`, 'Enter to cancel');
      expect(posts).toEqual([]);
    },
    STEP_MS * 3,
  );

  test(
    'a click on the backdrop leaves it open; Esc closes it and focus returns to the trigger',
    async () => {
      await page().click('#native button[command="show-modal"]');
      await until(`document.getElementById('withdraw').open === true`, 'the dialog to open');
      await page().click('#corner', { state: 'visible' });
      expect(await open('withdraw')).toBe(true);
      await page().press('Escape');
      await until(`document.getElementById('withdraw').open === false`, 'Esc to close');
      expect(await activeText()).toBe('Withdraw');
    },
    STEP_MS * 3,
  );

  test(
    'the dialog fits a 390px phone',
    async () => {
      await page().click('#native button[command="show-modal"]');
      await until(`document.getElementById('withdraw').open === true`, 'the dialog to open');
      const box = JSON.parse(
        String(
          await read(
            `JSON.stringify(document.getElementById('withdraw').getBoundingClientRect().toJSON())`,
          ),
        ),
      ) as { left: number; right: number };
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(VIEWPORT.width);
      expect(await read('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page().press('Escape');
    },
    STEP_MS * 3,
  );

  test(
    'in an island, a refusal stays open with focus on the summary; the retry closes it',
    async () => {
      await page().click('button[commandfor="delete"]');
      await until(`document.getElementById('delete').open === true`, 'the dialog to open');
      await page().click('#delete button:not([formmethod])');
      await until('window.__asked === 1', 'the first confirm');
      await until(
        `document.activeElement !== null && document.activeElement.textContent.includes('Only the owner')`,
        'the refusal to take focus',
      );
      expect(await open('delete')).toBe(true);
      await page().click('#delete button:not([formmethod])');
      await until(`document.getElementById('delete').open === false`, 'the retry to close it');
    },
    STEP_MS * 3,
  );

  test(
    'with no script on the page, the trigger opens it and the confirm posts',
    async () => {
      expect(staticMarkup).toContain('commandfor="withdraw"');
      await page().goto(`http://localhost:${String(server?.port)}/static`);
      expect(await read('document.scripts.length')).toBe(0);
      await page().click('button[command="show-modal"]');
      await until(`document.getElementById('withdraw').open === true`, 'the invoker to open it');
      await page().click('#withdraw button:not([formmethod])');
      await until(`document.body.textContent.trim() === 'posted'`, 'the native post');
      expect(posts).toEqual(['/submit p-1']);
    },
    STEP_MS * 3,
  );
});
