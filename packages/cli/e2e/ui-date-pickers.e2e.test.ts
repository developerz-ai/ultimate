// The date pickers in a real Chrome at 320px. With no script on the page, a `DateRangePicker` in a
// GET form posts both ends. In an island on a fine pointer, the keyboard picks a range in the
// calendar and Escape hands focus back to the opener; on a coarse pointer the native inputs stay
// alone. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { renderToHtml, stylesFor } from '@ultimat3/render/server';
import { E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import type { ShotClock, ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

// After `@ultimat3/render/server`: its `.tsx` loader is what compiles the components below.
const { Calendar, DateRangePicker } = await import('@ultimat3/ui');

const FILE = 'apps/web/site/date-range.island.tsx';
const VIEWPORT = { width: 320, height: 700 } as const;
/** The calendar's opener. Its NAME is the app's catalog; this island has none, so it is found by role. */
const OPENER = 'button[aria-haspopup="dialog"]';

const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { DateRangePicker, setSolidRuntime } from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  render(() => <DateRangePicker legend="Created" fromName="from" toName="to" month="2026-03-01" />, el);
  document.body.dataset.ready = '';
}
`;

/**
 * Runs before the page's own scripts: the pointer the page asks `matchMedia` about is the one the
 * URL names, so one session covers a mouse and a phone without a second browser.
 */
const POINTER = `(() => {
  const coarse = location.search.includes('coarse');
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) =>
    query === '(pointer: fine)' ? { matches: !coarse, media: query, addEventListener() {}, removeEventListener() {} } : real(query);
})();`;

const head = (css: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>dates</title><style>${css}</style>`;

const islandPage = (url: string, css: string): string => `${head(css)}<script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)}).then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error)));
</script></body></html>`;

interface Sass {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}
const sass = (await import(
  Bun.resolveSync('sass', join(import.meta.dir, '..', '..', 'render'))
)) as Sass;
const THEME = join(import.meta.dir, '..', '..', 'ui', 'src', 'tokens', 'theme.scss');

const clock: ShotClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  // real-clock: the shot driver's waits are on Chrome's time, another process's.
  sleep: (ms) => Bun.sleep(ms),
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const SHOT_TIMEOUT_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + 30_000 + 30 * SHOT_TIMEOUT_MS;

const text = async (session: ShotSession, expression: string): Promise<string> =>
  String(await session.page.evaluate(expression));

describe.skipIf(chrome === undefined && !required)('date pickers at 320px', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  let posted = '';
  let picked: { from: string; to: string; focus: string; open: boolean } | undefined;
  let escaped: { focus: string; open: boolean } | undefined;
  let cells: { width: number; height: number; right: number } | undefined;
  let coarse: { buttons: number; inputs: number } | undefined;
  let errors: readonly string[] = [];

  beforeAll(async () => {
    const form = await renderToHtml(
      DateRangePicker({ legend: 'Created', fromName: 'from', toName: 'to', month: '2026-03-01' }),
    );
    // A booking page's inline calendar: every day a link, 0 B of script.
    const inline = await renderToHtml(
      Calendar({ value: '2026-03-14', hrefFor: (date: string) => `/book?day=${date}` }),
    );
    app = await fixtureAppRoot('ui-date-pickers', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    const theme = sass.compileString(await Bun.file(THEME).text(), {
      url: Bun.pathToFileURL(THEME),
    });
    const css = `${theme.css}\n${stylesFor('site')}`;
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        const asset = bundle.assetAt(url.pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        const html = (body: string): Response =>
          new Response(body, { headers: { 'content-type': 'text/html' } });
        if (url.pathname === '/form') {
          return html(`${head(css)}</head><body><form method="get" action="/got">${form}
<button type="submit" id="send">Send</button></form><div id="inline">${inline}</div></body></html>`);
        }
        if (url.pathname === '/got') {
          return html(
            `<pre id="got">${JSON.stringify(Object.fromEntries(url.searchParams))}</pre>`,
          );
        }
        return html(islandPage(chunk.url, css));
      },
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    session = await cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT }).open({
      name: 'ui date pickers',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    const origin = `http://localhost:${String(server.port)}`;
    await session.page.prepare(POINTER);

    // No script on the page: the browser's own form submission carries both ends.
    await session.page.goto(`${origin}/form`);
    await session.page.evaluate(`(() => {
      const [from, to] = document.querySelectorAll('input[type="date"]');
      from.value = '2026-03-02';
      to.value = '2026-03-09';
    })()`);
    cells = JSON.parse(
      await text(
        session,
        `JSON.stringify((() => {
          const day = document.querySelector('#inline a').getBoundingClientRect();
          return { width: day.width, height: day.height, right: document.querySelector('#inline table').getBoundingClientRect().right };
        })())`,
      ),
    ) as typeof cells;
    await session.page.click('#send');
    posted = (await session.page.waitFor('#got', { state: 'attached' })).text ?? '';

    // A fine pointer: the keyboard picks a range, and the popover hands focus back.
    await session.page.goto(`${origin}/island`);
    await session.page.waitFor('body[data-ready]', { state: 'attached' });
    await session.page.focus(OPENER);
    await session.page.press('Enter');
    await session.page.waitFor('[role="grid"]', { state: 'attached' });
    await session.page.focus('[role="grid"] button[tabindex="0"]');
    await session.page.press('Enter');
    for (const _ of [1, 2, 3]) await session.page.press('ArrowRight');
    await session.page.press('Enter');
    const state = `JSON.stringify({
      from: document.querySelector('input[name="from"]').value,
      to: document.querySelector('input[name="to"]').value,
      focus: document.activeElement && document.activeElement.matches('${OPENER}') ? 'opener' : String(document.activeElement && document.activeElement.tagName),
      open: document.querySelector('[role="grid"]') !== null,
    })`;
    picked = JSON.parse(await text(session, state)) as typeof picked;
    await session.page.press('Enter');
    await session.page.waitFor('[role="grid"]', { state: 'attached' });
    await session.page.press('Escape');
    escaped = JSON.parse(await text(session, state)) as typeof escaped;
    errors = JSON.parse(await text(session, 'JSON.stringify(window.__errors)')) as string[];

    // A coarse pointer: the two native inputs, and nothing else.
    await session.page.goto(`${origin}/island?coarse`);
    await session.page.waitFor('body[data-ready]', { state: 'attached' });
    coarse = JSON.parse(
      await text(
        session,
        `JSON.stringify({ buttons: document.querySelectorAll('${OPENER}').length, inputs: document.querySelectorAll('input[type="date"]').length })`,
      ),
    ) as typeof coarse;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test('with no script, a range in a GET form posts both ends', () => {
    expect(JSON.parse(posted)).toEqual({ from: '2026-03-02', to: '2026-03-09' });
  });

  test('the keyboard picks a range in the calendar, and the second pick hands focus back', () => {
    expect(errors).toEqual([]);
    expect(picked).toEqual({ from: '2026-03-01', to: '2026-03-04', focus: 'opener', open: false });
  });

  test('Escape closes the calendar and returns focus to the opener', () => {
    expect(escaped?.open).toBe(false);
    expect(escaped?.focus).toBe('opener');
  });

  test('an inline calendar’s every day is a 44px target, and the month fits a 320px screen', () => {
    expect(cells?.width).toBeGreaterThanOrEqual(44);
    expect(cells?.height).toBeGreaterThanOrEqual(44);
    expect(cells?.right).toBeLessThanOrEqual(VIEWPORT.width);
  });

  test('a coarse pointer keeps the native inputs alone', () => {
    expect(coarse).toEqual({ buttons: 0, inputs: 2 });
  });
});
