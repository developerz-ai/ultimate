// `@ultimat3/ui`'s phone frame in a real Chrome at 390×844, in both writing directions: the last
// row of the page scrolls clear above `AppShell`'s bottom bar, nothing scrolls sideways, a bottom
// sheet dragged from its grabber past half its height closes and hands focus back, and a pull at
// the top of a list refreshes it once while the same pull mid-list does not. Real component CSS:
// the sheets the island build registered, after the theme and the reset. Skips with no Chrome,
// unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import type { SleepClock } from '@ultimat3/core';
import { registeredStylesheets } from '@ultimat3/render/server';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import type { ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/frame.island.tsx';
const VIEWPORT = { width: 390, height: 844 } as const;
const UI = join(import.meta.dir, '..', '..', 'ui', 'src');

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
import { AppShell, BottomNav, Drawer, NavList, PullToRefresh, setSolidRuntime } from '@ultimat3/ui';

const PLACES = [
  { label: 'Feed', href: '/feed', icon: '·' },
  { label: 'Runs', href: '/runs', icon: '·' },
  { label: 'Settings', href: '/settings', icon: '·' },
];

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const [open, setOpen] = createSignal(false);
  const host = window as unknown as { __refreshes: number };
  host.__refreshes = 0;
  render(
    () => (
      <AppShell
        header={<strong>Frame</strong>}
        sidebar={<NavList items={PLACES} currentHref="/feed" />}
        bottomNav={<BottomNav items={PLACES} currentHref="/feed" />}
      >
        <button type="button" id="open-sheet" onClick={() => setOpen(true)}>Comments</button>
        <PullToRefresh
          onRefresh={() => {
            host.__refreshes += 1;
            return Promise.resolve();
          }}
          onError={() => undefined}
        >
          <ul id="rows">
            {Array.from({ length: 60 }, (_, i) => (
              <li id={i === 59 ? 'last' : undefined}>Row {i + 1}</li>
            ))}
          </ul>
        </PullToRefresh>
        <Drawer open={open()} side="block-end" grabber title="Comments" onClose={() => setOpen(false)}>
          <p>Sheet body</p>
        </Drawer>
      </AppShell>
    ),
    el,
  );
}
`;

interface SassApi {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}
const sass = (await import(
  Bun.resolveSync('sass', join(import.meta.dir, '..', '..', 'render'))
)) as SassApi;
const global = async (relative: string): Promise<string> => {
  const path = join(UI, relative);
  return sass.compileString(await Bun.file(path).text(), { url: Bun.pathToFileURL(path) }).css;
};

/**
 * The test's one stand-in: headless desktop Chrome answers `(pointer: fine)`, where the pull is
 * deliberately off. Every other media query is the browser's own.
 */
const COARSE = `<script>
const realMatch = window.matchMedia.bind(window);
window.matchMedia = (query) =>
  query === '(pointer: fine)' ? { matches: false, media: query, addEventListener() {}, removeEventListener() {} } : realMatch(query);
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script>`;

const documentFor = (url: string, css: string, dir: 'ltr' | 'rtl'): string => `<!doctype html>
<html lang="en" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, viewport-fit=cover"><style>${css}</style>${COARSE}</head>
<body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** A one-finger pull on the list's wrapper, from `y` down by `by` px, as untrusted touch events. */
const pull = (y: number, by: number): string => `(() => {
  const target = document.getElementById('rows').parentElement.parentElement;
  const at = (clientY) => new Touch({ identifier: 1, target, clientX: 100, clientY });
  const fire = (type, touches) =>
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: touches }));
  fire('touchstart', [at(${y})]);
  for (let step = 1; step <= 10; step += 1) fire('touchmove', [at(${y} + (${by} * step) / 10)]);
  fire('touchend', []);
  return true;
})()`;

/** A drag on the open sheet's grabber, by `share` of the sheet's height, as pointer events. */
const drag = (share: number): string => `(() => {
  const sheet = document.querySelector('dialog[open]');
  const grabber = sheet.querySelector('div[aria-hidden="true"]');
  const box = grabber.getBoundingClientRect();
  const height = sheet.getBoundingClientRect().height;
  const y = box.top + box.height / 2;
  const fire = (type, clientY) =>
    grabber.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: box.left + 4, clientY }));
  fire('pointerdown', y);
  fire('pointermove', y + height * ${share});
  fire('pointerup', y + height * ${share});
  return true;
})()`;

const clock: SleepClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  // real-clock: the poll waits on Chrome, another process, which no fake timer moves.
  sleep: (ms) => Bun.sleep(ms),
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const STEP_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + 30_000 + 4 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)('the phone frame at 390×844', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;

  const page = () => session?.page ?? expect.unreachable('no browser session');
  const read = (expression: string): Promise<unknown> => page().evaluate(expression);
  const until = async (expression: string, what: string): Promise<void> => {
    const started = clock.monotonic();
    while ((await read(expression)) !== true) {
      if (clock.monotonic() - started > STEP_MS)
        expect.unreachable(`timed out waiting for ${what}`);
      await clock.sleep(25);
    }
  };
  const visit = async (dir: 'ltr' | 'rtl'): Promise<void> => {
    await page().goto(`http://localhost:${String(server?.port)}/${dir}`);
    await until('window.__done === true', 'the island to mount');
    expect(JSON.parse(String(await read('JSON.stringify(window.__errors)')))).toEqual([]);
  };

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-mobile-frame', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    const css = [
      await global('tokens/theme.scss'),
      await global('tokens/reset.scss'),
      ...registeredStylesheets().map((sheet) => sheet.css),
    ].join('\n');
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        const asset = bundle.assetAt(path);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        const html = documentFor(chunk.url, css, path === '/rtl' ? 'rtl' : 'ltr');
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    session = await cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT }).open({
      name: 'ui mobile frame',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: DEFAULT_CDP_TIMEOUT_MS,
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  for (const dir of ['ltr', 'rtl'] as const) {
    test(
      `${dir}: the last row scrolls clear above the bottom bar, and nothing scrolls sideways`,
      async () => {
        await visit(dir);
        await read('window.scrollTo(0, document.scrollingElement.scrollHeight)');
        const fit = JSON.parse(
          String(
            await read(`JSON.stringify({
            last: document.getElementById('last').getBoundingClientRect().bottom,
            bar: [...document.querySelectorAll('nav')].at(-1).getBoundingClientRect().top,
            barBottom: [...document.querySelectorAll('nav')].at(-1).getBoundingClientRect().bottom,
            bars: [...document.querySelectorAll('a[aria-current="page"]')].length,
            wide: document.documentElement.scrollWidth <= innerWidth,
          })`),
          ),
        ) as { last: number; bar: number; barBottom: number; bars: number; wide: boolean };
        expect(fit.wide).toBe(true);
        // The bar is on screen, pinned to the bottom edge, and the last row ends above it.
        expect(Math.abs(fit.barBottom - VIEWPORT.height)).toBeLessThanOrEqual(1);
        expect(fit.last).toBeLessThanOrEqual(fit.bar + 1);
        // One current link per list: the sidebar's and the bar's.
        expect(fit.bars).toBe(2);
      },
      STEP_MS * 3,
    );
  }

  test(
    'a sheet dragged from its grabber past half its height closes, and focus returns',
    async () => {
      await visit('ltr');
      await page().click('#open-sheet');
      await until(`document.querySelector('dialog[open]') !== null`, 'the sheet to open');
      // A short drag settles back.
      await read(drag(0.1));
      expect(await read(`document.querySelector('dialog[open]') !== null`)).toBe(true);
      await read(drag(0.6));
      await until(`document.querySelector('dialog[open]') === null`, 'the drag to close the sheet');
      expect(await read('document.activeElement.id')).toBe('open-sheet');
    },
    STEP_MS * 3,
  );

  test(
    'a pull at the top refreshes once; the same pull mid-list does not',
    async () => {
      await visit('ltr');
      await read('window.scrollTo(0, 0)');
      await read(pull(200, 400));
      await until('window.__refreshes === 1', 'the pull to refresh');
      await read('window.scrollTo(0, 600)');
      await read(pull(200, 400));
      await clock.sleep(0);
      expect(await read('window.__refreshes')).toBe(1);
    },
    STEP_MS * 3,
  );
});
