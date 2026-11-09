// `SearchableSelect` in a real Chrome at a 390px phone width, both halves: with no script the
// server's native `<select>` posts the chosen value; with the island mounted, a typed name that is
// no option posts the PREVIOUS value — never the text — and a pick by keyboard posts its value.
// Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { renderComponent, stylesFor } from '@ultimat3/render/server';
import { E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import { SearchableSelect } from '@ultimat3/ui';
import type { ShotClock, ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/zone-picker.island.tsx';
const VIEWPORT = { width: 390, height: 700 } as const;

const ZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Berlin', label: 'Berlin', group: 'Europe', description: 'Europe/Berlin' },
  { value: 'Europe/Madrid', label: 'Madrid', group: 'Europe', description: 'Europe/Madrid' },
  { value: 'Asia/Tokyo', label: 'Tokyo', group: 'Asia', description: 'Asia/Tokyo' },
];

/** The same control the server rendered, mounted over it: the island replaces its shell. */
const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { SearchableSelect, setSolidRuntime } from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  el.textContent = '';
  render(
    () => <SearchableSelect id="tz" name="tz" required options={${JSON.stringify(ZONES)}} value="Europe/Berlin" />,
    el,
  );
}
`;

const page = (css: string, control: string, script: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>zone</title><style>${css}</style></head><body>
<form method="post" action="/post"><label for="tz">Time zone</label>
<div id="slot">${control}</div><button type="submit" id="send">Save</button></form>${script}
</body></html>`;

const islandScript = (url: string): string => `<script type="module">
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
import(${JSON.stringify(url)}).then((island) => island.mount(document.getElementById('slot'), {}))
  .catch((error) => window.__errors.push(String(error)));
</script>`;

const clock: ShotClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  // real-clock: the shot driver's waits are on Chrome's time, another process's.
  sleep: (ms) => Bun.sleep(ms),
};

interface Sass {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}
/** `sass` is `@ultimat3/render`'s dependency, resolved from its directory — never a second copy. */
const sass = (await import(
  Bun.resolveSync('sass', join(import.meta.dir, '..', '..', 'render'))
)) as Sass;
/** What an app's document shell carries: every custom property, then the reset. */
const THEME = join(import.meta.dir, '..', '..', 'ui', 'src', 'global.scss');

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const SHOT_TIMEOUT_MS = 20_000;
const BUILD_MS = 30_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + 12 * SHOT_TIMEOUT_MS;

/** What the last form post carried, as the server read it. */
const posted: string[] = [];

describe.skipIf(chrome === undefined && !required)('SearchableSelect at 390px', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;

  const postedAfter = async (submit: () => Promise<void>): Promise<string> => {
    const before = posted.length;
    await submit();
    await session?.page.waitFor('#posted', { state: 'attached' });
    return posted[before] ?? 'nothing posted';
  };

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-searchable-select', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    const shell = await renderComponent(
      SearchableSelect as never,
      { id: 'tz', name: 'tz', required: true, options: ZONES, value: 'Europe/Berlin' },
      FILE,
    );
    const theme = sass.compileString(await Bun.file(THEME).text(), {
      url: Bun.pathToFileURL(THEME),
    });
    const css = `${theme.css}\n${stylesFor('site')}`;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const asset = bundle.assetAt(url.pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        if (url.pathname === '/post') {
          const form = await request.formData();
          posted.push(form.getAll('tz').map(String).join(','));
          return new Response('<p id="posted">ok</p>', {
            headers: { 'content-type': 'text/html' },
          });
        }
        const script = url.pathname === '/js' ? islandScript(chunk.url) : '';
        return new Response(page(css, shell, script), { headers: { 'content-type': 'text/html' } });
      },
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    session = await cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT }).open({
      name: 'ui searchable select',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  const base = (): string => `http://localhost:${String(server?.port)}`;

  test(
    'scripting off: the native select posts the chosen value',
    async () => {
      const page = session?.page ?? expect.unreachable('no session');
      await page.goto(`${base()}/`);
      expect(await page.query('[role="combobox"]')).toHaveLength(0);
      await page.evaluate(`document.querySelector('select[name="tz"]').value = 'Asia/Tokyo'`);
      expect(await postedAfter(() => page.click('#send'))).toBe('Asia/Tokyo');
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'scripting on: a typed non-option, then blur, posts the previous value, never the text',
    async () => {
      const page = session?.page ?? expect.unreachable('no session');
      await page.goto(`${base()}/js`);
      await page.waitFor('[data-mounted="true"]', { state: 'attached' });
      await page.type('[role="combobox"]', 'Atlantis');
      await page.press('Tab');
      expect(await postedAfter(() => page.click('#send'))).toBe('Europe/Berlin');
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'scripting on: typing and Enter pick by value, by keyboard alone, on a phone',
    async () => {
      const page = session?.page ?? expect.unreachable('no session');
      await page.goto(`${base()}/js`);
      await page.waitFor('[data-mounted="true"]', { state: 'attached' });
      await page.focus('[role="combobox"]');
      await page.press('Control+A');
      await page.type('[role="combobox"]', 'tok');
      // Role and name, as assistive tech reads them: the label names the combobox, rows are options.
      const field = await page.accessibility('[role="combobox"]');
      expect(field.some((node) => node.role === 'combobox' && node.name === 'Time zone')).toBe(
        true,
      );
      const row = await page.accessibility('[role="option"][data-active="true"]');
      expect(row.some((node) => node.role === 'option' && node.name.startsWith('Tokyo'))).toBe(
        true,
      );
      await page.press('Enter');
      const fits = await page.evaluate(
        'document.documentElement.scrollWidth <= window.innerWidth && !window.__errors.length',
      );
      expect(fits).toBe(true);
      expect(await postedAfter(() => page.click('#send'))).toBe('Asia/Tokyo');
    },
    HOOK_TIMEOUT_MS,
  );
});
