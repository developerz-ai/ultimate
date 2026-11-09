// The viewers inside a REAL island in a real Chrome, under a strict CSP and with the package's own
// stylesheets: a hostile markdown body raises no alert and adds no element a body named; a wide
// table leaves a 390 px page unscrolled sideways; a log follows its end and lets go on scroll up;
// code stays left-to-right under `dir="rtl"`. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
// Command: bun test packages/cli/e2e/ui-viewers.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Node's path module, as every e2e here resolves a package file by path.
import { resolve } from 'node:path';
import { compileStylesheet, registeredStylesheets } from '@ultimat3/render/server';
import type { E2eBrowser } from '@ultimat3/testing';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_OPEN_MS,
  findChrome,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/viewers.island.tsx';

const HOSTILE = [
  '# Report',
  '',
  '<script>alert(1)</script>',
  '',
  '<img src=x onerror="alert(2)">',
  '',
  '[click](javascript:alert(3)) ![pixel](https://tracker.invalid/p.gif)',
  '',
  '| a | b | c | d | e | f |',
  '|---|---|---|---|---|---|',
  `| ${'wide '.repeat(60)} | 2 | 3 | 4 | 5 | 6 |`,
  '',
  '```ts',
  'const answer = "</code><script>alert(4)</script>";',
  '```',
].join('\n');

const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { LogViewer, Markdown, setSolidRuntime, tsLanguage, UiProvider } from '@ultimat3/ui';

const w = window as unknown as Record<string, unknown>;
const line = (n: number) => ({ id: String(n), text: 'line ' + n, level: 'info' as const });

export function mount(el: HTMLElement, props: { body: string }): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const [lines, setLines] = createSignal(Array.from({ length: 2000 }, (_, i) => line(i)));
  w.__more = () => setLines([...lines(), line(lines().length)]);
  render(
    () => (
      <UiProvider locale={document.documentElement.dir === 'rtl' ? 'ar' : 'en'}>
        <Markdown text={props.body} languages={[tsLanguage]} />
        <LogViewer lines={lines()} label="Log" />
      </UiProvider>
    ),
    el,
  );
}
`;

/** No inline script anywhere: the CSP below forbids it, and the boot is a file of its own. */
const BOOT = `window.__alerts = [];
window.alert = (message) => window.__alerts.push(String(message));
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
const url = document.documentElement.dataset.entry;
import(url)
  .then((island) => island.mount(document.getElementById('root'), { body: ${JSON.stringify(HOSTILE)} }))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });`;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'";

const documentFor = (url: string, dir: string): string => `<!doctype html>
<html lang="en" dir="${dir}" data-entry="${url}"><head><meta charset="utf-8"><title>viewers</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head>
<body><div id="root"></div><script type="module" src="/boot.js"></script></body></html>`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 4 * DEFAULT_CDP_TIMEOUT_MS;

const UI_TOKENS = resolve(import.meta.dir, '..', '..', 'ui', 'src', 'tokens');

describe.skipIf(chrome === undefined && !required)('the viewers in a browser', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: E2eBrowser | undefined;
  let base = '';
  let followProbe: { atEndFirst: boolean; followed: boolean } | undefined;

  const open = async (path: string): Promise<void> => {
    await browser?.page.goto(`${base}${path}`);
    await browser?.page.waitFor(
      'window.__done === true',
      'the island to finish mounting',
      MOUNT_MS,
    );
  };
  const json = async (expression: string): Promise<unknown> =>
    JSON.parse(String(await browser?.page.evaluate(expression)));

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-viewers', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    // The tokens and the reset first, then every module sheet the island build registered.
    const globals = await Promise.all(
      ['theme.scss', 'reset.scss'].map(async (name) => {
        const file = resolve(UI_TOKENS, name);
        return compileStylesheet(file, await Bun.file(file).text()).css;
      }),
    );
    const styles = [...globals, ...registeredStylesheets().map((sheet) => sheet.css)].join('\n');
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        const headers = { 'content-security-policy': CSP };
        const asset = bundle.assetAt(url.pathname);
        if (asset !== undefined) {
          return new Response(asset.code, {
            headers: { ...headers, 'content-type': 'text/javascript' },
          });
        }
        if (url.pathname === '/boot.js') {
          return new Response(BOOT, { headers: { ...headers, 'content-type': 'text/javascript' } });
        }
        if (url.pathname === '/styles.css') {
          return new Response(styles, { headers: { ...headers, 'content-type': 'text/css' } });
        }
        // The phone: the same page in a frame exactly 390 px wide, so `innerWidth` is the phone's.
        if (url.pathname === '/phone') {
          const frame =
            '<!doctype html><html lang="en"><head><title>phone</title></head><body style="margin:0"><iframe id="phone" title="A 390 px phone" src="/?dir=ltr" width="390" height="800" style="border:0"></iframe></body></html>';
          return new Response(frame, { headers: { ...headers, 'content-type': 'text/html' } });
        }
        const page = documentFor(chunk.url, url.searchParams.get('dir') ?? 'ltr');
        return new Response(page, { headers: { ...headers, 'content-type': 'text/html' } });
      },
    });
    base = `http://localhost:${String(server.port)}`;
    browser = await (required ? openE2eBrowser() : openE2eBrowserIfAvailable());
    if (browser === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test(
    'a hostile body raises no alert and adds no element the body named',
    async () => {
      await open('/?dir=ltr');
      const probe = (await json(`JSON.stringify({
      alerts: window.__alerts,
      errors: window.__errors,
      scripts: document.querySelectorAll('#root script').length,
      images: document.querySelectorAll('#root img').length,
      handlers: [...document.querySelectorAll('#root *')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
      javascript: [...document.querySelectorAll('#root a')].filter((a) => /^\\s*javascript:/i.test(a.getAttribute('href') || '')).length,
      text: document.getElementById('root').textContent.includes('<script>alert(1)</script>'),
    })`)) as Record<string, unknown>;
      expect(probe).toEqual({
        alerts: [],
        errors: [],
        scripts: 0,
        images: 0,
        handlers: 0,
        javascript: 0,
        text: true,
      });
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a wide table scrolls in its own box: the 390 px page never scrolls sideways',
    async () => {
      await browser?.page.goto(`${base}/phone`);
      await browser?.page.waitFor(
        'document.getElementById("phone").contentWindow.__done === true',
        'the framed island to mount',
        MOUNT_MS,
      );
      const widths = (await json(`(() => {
      const win = document.getElementById('phone').contentWindow;
      const doc = win.document;
      return JSON.stringify({ inner: win.innerWidth, scroll: doc.documentElement.scrollWidth,
        table: doc.querySelector('table').scrollWidth });
    })()`)) as { inner: number; scroll: number; table: number };
      expect(widths.inner).toBe(390);
      expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a log follows its end, mounts a screenful, and lets go when scrolled up',
    async () => {
      await open('/?dir=ltr');
      // A few frames: the list measures its rows, then corrects its scroll to the end.
      const frame =
        'for (let i = 0; i < 6; i += 1) await new Promise((r) => requestAnimationFrame(r));';
      const probe = (await json(`(async () => {
      const box = document.querySelector('section[aria-label="Log"] ul').parentElement;
      ${frame}
      // AT the end, to the pixel: the rows measure ~31 px against a 48 px estimate, and a list
      // that re-pinned only on a layout change settled 52 px short when its drawn range moved.
      const end = () => box.scrollHeight - box.scrollTop - box.clientHeight < 2;
      const mounted = box.querySelectorAll('li').length;
      const atEndFirst = end();
      window.__more();
      ${frame}
      const followed = end();
      box.scrollTop = 0;
      box.dispatchEvent(new Event('scroll'));
      ${frame}
      window.__more();
      ${frame}
      return JSON.stringify({ mounted, atEndFirst, followed, released: box.scrollTop < 50 });
    })()`)) as { mounted: number; atEndFirst: boolean; followed: boolean; released: boolean };
      expect(probe.mounted).toBeLessThan(100);
      expect(probe.released).toBe(true);
      followProbe = probe;
    },
    HOOK_TIMEOUT_MS,
  );

  /**
   * Rows measuring shorter than the estimate (30.9 px against 48) move the drawn range without a
   * layout change; a list that re-pinned only on the layout settled ~52 px short, unpinned by its
   * own hysteresis. `VirtualList` re-pins on the range too.
   */
  test('the following log sits at its end, and stays there as a line arrives', () => {
    expect(followProbe?.atEndFirst).toBe(true);
    expect(followProbe?.followed).toBe(true);
  });

  test(
    'under dir="rtl" code stays left-to-right',
    async () => {
      await open('/?dir=rtl');
      const dir = await browser?.page.evaluate(
        `getComputedStyle(document.querySelector('pre')).direction`,
      );
      expect(dir).toBe('ltr');
      const page = await browser?.page.evaluate('getComputedStyle(document.body).direction');
      expect(page).toBe('rtl');
    },
    HOOK_TIMEOUT_MS,
  );
});
