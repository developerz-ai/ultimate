// `Board` and `SplitPane` under a REAL finger in Chrome (`touchDrag`: `Input.dispatchTouchEvent`,
// trusted, hit-tested, `touch-action` honoured), with the components' real stylesheets: a finger
// on a card's handle carries it across columns through one `onMove`; a finger on the separator
// resizes the split; a finger dragged on a card's BODY scrolls the page, the browser cancels the
// pointer, and the row is never lifted — because the handle and the separator are the only
// `touch-action: none` boxes. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
// Command: bun test ./packages/cli/e2e/ui-drag-touch.e2e.test.ts
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

/** Two columns, a split and a tall tail to scroll into; every `onMove` and resize recorded. */
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
  const sizes: number[] = [];
  w.__moves = moves;
  w.__sizes = sizes;
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
          <SplitPane start={<p>log</p>} end={<p>detail</p>} defaultValue={40} min={20} max={80}
            onResize={(percent: number) => sizes.push(percent)} />
        </div>
        <div style="height: 3000px">tail</div>
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
window.__cancels = [];
addEventListener('pointercancel', (event) => window.__cancels.push(event.pointerType), true);
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** A viewport point, the shape `touchDrag` takes. */
interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** Where a finger lands: the centre of the first element `selector` matches, in the viewport. */
const centreOf = (selector: string): string => `(() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`;

/** What a gesture left behind: the requests, the lift, the split, the scroll, the cancels. */
const OUTCOME = `JSON.stringify({
  moves: window.__moves.map((move) => [move.id, move.toGroup]),
  sizes: window.__sizes,
  lifted: document.querySelector('li[data-sort-key="a"]').getAttribute('data-lifted'),
  column: document.querySelector('li[data-sort-key="a"]').closest('section').getAttribute('aria-label'),
  scrolled: scrollY > 0,
  cancels: window.__cancels,
  errors: window.__errors,
})`;

interface Outcome {
  readonly moves: readonly (readonly string[])[];
  readonly sizes: readonly number[];
  readonly lifted: string | null;
  readonly column: string;
  readonly scrolled: boolean;
  readonly cancels: readonly string[];
  readonly errors: readonly string[];
}

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

  const page = () => browser?.page ?? expect.unreachable('no browser');
  const read = async <T>(expression: string): Promise<T> =>
    JSON.parse(String(await page().evaluate(expression))) as T;
  const visit = async (): Promise<void> => {
    await page().goto(base);
    await page().waitFor('window.__done === true', 'the island to mount', MOUNT_MS);
  };
  /** A finger from `from`'s centre to `to`, then the outcome once the page has settled. */
  const finger = async (from: string, to: (start: TouchPoint) => Promise<TouchPoint>) => {
    const start = await read<TouchPoint>(centreOf(from));
    await page().touchDrag(start, await to(start), 8);
    await page().waitFor('new Promise((r) => requestAnimationFrame(() => r(true)))', 'a frame');
    return read<Outcome>(OUTCOME);
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
    'a finger on the handle carries a card across columns: one request, the row settled',
    async () => {
      await visit();
      // Past the middle of the board: the preview re-parents the row into the second column,
      // which released the capture and cancelled the drag before `pointer-drag.ts` took it back.
      const out = await finger('[data-sort-handle="a"]', () =>
        read<TouchPoint>(centreOf('section[role="group"]:nth-of-type(2)')),
      );
      expect(out.errors).toEqual([]);
      expect(out.moves).toEqual([['a', 'doing']]);
      expect(out.lifted).toBeNull();
      expect(out.cancels).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a finger on the separator resizes the split, and the release keeps it',
    async () => {
      await visit();
      const out = await finger('[role="separator"]', async (start) => {
        const box = await read<{ left: number; width: number }>(
          `(() => { const r = document.querySelector('[role="separator"]').parentElement.getBoundingClientRect(); return JSON.stringify({ left: r.left, width: r.width }); })()`,
        );
        return { x: box.left + box.width * 0.7, y: start.y };
      });
      expect(out.errors).toEqual([]);
      expect(out.sizes.at(-1)).toBe(70);
      expect(out.cancels).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a finger dragged up a card BODY scrolls the page: the pointer is cancelled, the row never lifts',
    async () => {
      await visit();
      const out = await finger('li[data-sort-key="a"] .title', async (start) => ({
        x: start.x,
        y: Math.max(1, start.y - 300),
      }));
      expect(out.scrolled).toBe(true);
      expect(out.cancels).toContain('touch');
      expect(out.lifted).toBeNull();
      expect(out.moves).toEqual([]);
      expect(out.column).toBe('To do');
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'only the handle and the separator refuse the browser pan, so the page scrolls from a card',
    async () => {
      await visit();
      const actions = await read<Record<string, string>>(`JSON.stringify({
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
