// `Board` and `SplitPane` under a FINGER in a real Chrome, with the components' real stylesheets:
// the handle and the separator are the only `touch-action: none` boxes, which is what leaves the
// page scrollable from a card's body, and a touch dragged on a card's body never lifts it. A drag
// carried by a finger needs TRUSTED touch input (`Input.dispatchTouchEvent`): a page-dispatched
// touch PointerEvent names no active pointer, so `setPointerCapture` refuses it. Skips with no
// Chrome, unless E2E_BROWSER_REQUIRED=1. Command: bun test ./packages/cli/e2e/ui-drag-touch.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { registeredStylesheets } from '@ultimat3/render/server';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { E2eBrowser } from '@ultimat3/testing';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_OPEN_MS,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/drag-touch.island.tsx';
const UI = join(import.meta.dir, '..', '..', 'ui', 'src');

/** Two columns and a split; every `onMove` recorded. */
const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { Board, SplitPane, setSolidRuntime, UiProvider } from '@ultimat3/ui';

interface Card { id: string; title: string }
const w = window as unknown as Record<string, unknown>;

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const moves: unknown[] = [];
  w.__moves = moves;
  render(
    () => (
      <UiProvider locale="en">
        <Board
          label="Tasks"
          groups={[
            { id: 'todo', label: 'To do', items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] },
            { id: 'doing', label: 'Doing', items: [] },
          ]}
          itemKey={(card: Card) => card.id}
          renderItem={(card: Card) => <span class="title">{card.title}</span>}
          onMove={(move: unknown) => { moves.push(move); }}
        />
        <div style="width: 900px">
          <SplitPane start={<p>log</p>} end={<p>detail</p>} defaultValue={40} />
        </div>
      </UiProvider>
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

const documentFor = (url: string, css: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>touch</title>
<meta name="viewport" content="width=device-width"><style>${css}</style><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/**
 * One finger on a card's BODY (pointer id 2, never the mouse's always-active id 1), dragged in five
 * frames to the second column and released. Answers the recorded moves and the row's lift midway.
 */
const BODY_DRAG = `(async () => {
  const start = document.querySelector('li[data-sort-key="a"] .title');
  const a = start.getBoundingClientRect();
  const r = document.querySelectorAll('section[role="group"]')[1].getBoundingClientRect();
  const b = { x: r.left + r.width / 2, y: r.top + 20 };
  const at = (x, y, type) => start.dispatchEvent(new PointerEvent(type, {
    pointerId: 2, pointerType: 'touch', isPrimary: true, button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
  at(x0, y0, 'pointerdown');
  for (let step = 1; step <= 5; step += 1) {
    at(x0 + ((b.x - x0) * step) / 5, y0 + ((b.y - y0) * step) / 5, 'pointermove');
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const lifted = document.querySelector('li[data-sort-key="a"]').getAttribute('data-lifted');
  at(b.x, b.y, 'pointerup');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return JSON.stringify({ moves: window.__moves, lifted, errors: window.__errors });
})()`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 4 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)('Board and SplitPane under touch', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: E2eBrowser | undefined;
  let base = '';

  const run = async (expression: string): Promise<Record<string, unknown>> => {
    await browser?.page.goto(base);
    await browser?.page.waitFor('window.__done === true', 'the island to mount', MOUNT_MS);
    return JSON.parse(String(await browser?.page.evaluate(expression))) as Record<string, unknown>;
  };

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-drag-touch', [{ path: FILE, contents: ISLAND }]);
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
        const asset = bundle.assetAt(new URL(request.url).pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        return new Response(documentFor(chunk.url, css), {
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    base = `http://localhost:${String(server.port)}/`;
    browser = await (required ? openE2eBrowser() : openE2eBrowserIfAvailable());
    if (browser === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test(
    'a finger dragged on a card BODY never lifts it: the gesture belongs to the handle',
    async () => {
      expect(await run(BODY_DRAG)).toEqual({ moves: [], lifted: null, errors: [] });
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'only the handle and the separator refuse the browser pan, so the page scrolls from a card',
    async () => {
      const actions = await run(`JSON.stringify({
          handle: getComputedStyle(document.querySelector('[data-sort-handle="a"]')).touchAction,
          body: getComputedStyle(document.querySelector('li[data-sort-key="a"] .title')).touchAction,
          row: getComputedStyle(document.querySelector('li[data-sort-key="a"]')).touchAction,
          separator: getComputedStyle(document.querySelector('[role="separator"]')).touchAction,
        })`);
      expect(actions).toEqual({ handle: 'none', body: 'auto', row: 'auto', separator: 'none' });
    },
    HOOK_TIMEOUT_MS,
  );
});
