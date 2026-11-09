// `Board` and `SplitPane` inside a REAL island in a real Chrome: a card crosses columns by
// keyboard and by a pointer drag through one `onMove`; a live update while a card is lifted keeps
// its node; `dir="rtl"` mirrors the arrows; Esc restores a dragged split; and with scripting off
// each card is a form that posts. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
// Command: bun test packages/cli/e2e/ui-drag.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

const FILE = 'apps/web/site/drag.island.tsx';

/** Three columns, `canDrop` refusing `done`; every `onMove` recorded; `__tick` a live update. */
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
  const [cards, setCards] = createSignal<Card[]>([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  w.__tick = (title: string) => setCards([{ id: 'a', title }, { id: 'b', title: 'B' }]);
  render(
    () => (
      <UiProvider locale={document.documentElement.dir === 'rtl' ? 'ar' : 'en'}>
        <Board
          label="Tasks"
          groups={[
            { id: 'todo', label: 'To do', items: cards() },
            { id: 'doing', label: 'Doing', items: [] },
            { id: 'done', label: 'Done', items: [] },
          ]}
          itemKey={(card: Card) => card.id}
          renderItem={(card: Card) => <span class="title">{card.title}</span>}
          onMove={(move: unknown) => { moves.push(move); }}
          canDrop={(_card: Card, group: string) => group !== 'done'}
        />
        <div style="width: 900px">
          <SplitPane start={<p>log</p>} end={<p>detail</p>} defaultValue={40} min={20} max={80}
            onResize={(percent: number) => sizes.push(percent)} />
        </div>
      </UiProvider>
    ),
    el,
  );
}
`;

/** The no-script page: the same Board, server-shaped — a form per card — with no island at all. */
const NO_SCRIPT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>forms</title></head><body>
<form method="post" action="/move"><input type="hidden" name="id" value="a"><input type="hidden" name="fromGroup" value="todo">
<select name="toGroup" aria-label="Move to"><option value="todo" selected>To do</option><option value="doing">Doing</option></select>
<button type="submit" id="submit-a">Move</button></form></body></html>`;

const documentFor = (
  url: string,
  dir: string,
): string => `<!doctype html><html lang="en" dir="${dir}"><head>
<meta charset="utf-8"><title>drag</title><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** Keys pressed at the focused handle, the way a person does: one keydown per key. */
const press = (id: string, keys: readonly string[]): string => `(async () => {
  const handle = () => document.querySelector('[data-sort-handle="${id}"]');
  for (const key of ${JSON.stringify(keys)}) {
    handle().focus();
    handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return JSON.stringify(window.__moves);
})()`;

/** A mouse drag from a card's handle to the middle of a column: pointer 1 is always active. */
const drag = (id: string, column: number): string => `(async () => {
  const handle = document.querySelector('[data-sort-handle="${id}"]');
  const from = handle.getBoundingClientRect();
  const to = document.querySelectorAll('section[role="group"]')[${column}].getBoundingClientRect();
  const at = (x, y, type, buttons) => handle.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y,
    bubbles: true, cancelable: true,
  }));
  const x0 = from.left + from.width / 2, y0 = from.top + from.height / 2;
  at(x0, y0, 'pointerdown', 1);
  const x1 = to.left + to.width / 2, y1 = to.top + 20;
  for (let step = 1; step <= 5; step += 1) {
    at(x0 + ((x1 - x0) * step) / 5, y0 + ((y1 - y0) * step) / 5, 'pointermove', 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  at(x1, y1, 'pointerup', 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return JSON.stringify(window.__moves);
})()`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 4 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)('Board and SplitPane in a browser', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: E2eBrowser | undefined;
  let base = '';
  const posted: string[] = [];

  const open = async (dir: string): Promise<void> => {
    await browser?.page.goto(`${base}/?dir=${dir}`);
    await browser?.page.waitFor(
      'window.__done === true',
      'the island to finish mounting',
      MOUNT_MS,
    );
  };
  const json = async (expression: string): Promise<unknown> =>
    JSON.parse(String(await browser?.page.evaluate(expression)));

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-drag', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const asset = bundle.assetAt(url.pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        if (request.method === 'POST') {
          posted.push(new URLSearchParams(await request.text()).toString());
          return new Response('moved', { headers: { 'content-type': 'text/plain' } });
        }
        if (url.pathname === '/forms') {
          return new Response(NO_SCRIPT, { headers: { 'content-type': 'text/html' } });
        }
        const page = documentFor(chunk.url, url.searchParams.get('dir') ?? 'ltr');
        return new Response(page, { headers: { 'content-type': 'text/html' } });
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
    'keyboard only: Space, ArrowRight, Space moves a card across columns, once',
    async () => {
      await open('ltr');
      expect(await json(press('a', [' ', 'ArrowRight', ' ']))).toEqual([
        { id: 'a', fromGroup: 'todo', toGroup: 'doing', toIndex: 0 },
      ]);
      expect(await json('JSON.stringify(window.__errors)')).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'Escape after a lift calls nothing, and a refused column is skipped',
    async () => {
      await open('ltr');
      expect(await json(press('b', [' ', 'ArrowRight', 'Escape']))).toEqual([]);
      expect(await json(press('b', [' ', 'ArrowRight', 'ArrowRight', ' ']))).toEqual([
        { id: 'b', fromGroup: 'todo', toGroup: 'doing', toIndex: 0 },
      ]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a mouse drag across columns requests the same move',
    async () => {
      await open('ltr');
      const moves = (await json(drag('a', 1))) as { toGroup: string }[];
      expect(moves.map((move) => move.toGroup)).toEqual(['doing']);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'a live update during a lift keeps the lifted row and its focus',
    async () => {
      await open('ltr');
      const probe = (await json(`(() => {
      const row = () => document.querySelector('li[data-sort-key="a"]');
      const before = row();
      const handle = document.querySelector('[data-sort-handle="a"]');
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      window.__tick('A2');
      return JSON.stringify({
        same: row() === before,
        lifted: row().getAttribute('data-lifted'),
        title: row().querySelector('.title').textContent,
        focus: document.activeElement && document.activeElement.getAttribute('data-sort-handle'),
      });
    })()`)) as Record<string, unknown>;
      expect(probe).toEqual({ same: true, lifted: 'true', title: 'A2', focus: 'a' });
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'under dir="rtl" ArrowLeft is the next column',
    async () => {
      await open('rtl');
      expect(await json(press('a', [' ', 'ArrowLeft', ' ']))).toEqual([
        { id: 'a', fromGroup: 'todo', toGroup: 'doing', toIndex: 0 },
      ]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'SplitPane: arrows step it, and Escape mid-drag restores it',
    async () => {
      await open('ltr');
      const sizes = (await json(`(async () => {
      const separator = document.querySelector('[role="separator"]');
      separator.focus();
      separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const box = separator.parentElement.getBoundingClientRect();
      const r = separator.getBoundingClientRect();
      const at = (x, type, buttons) => separator.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons,
        clientX: x, clientY: r.top + 5, bubbles: true, cancelable: true,
      }));
      at(r.left + 2, 'pointerdown', 1);
      at(box.left + box.width * 0.7, 'pointermove', 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return JSON.stringify({ sizes: window.__sizes, now: separator.getAttribute('aria-valuenow') });
    })()`)) as { sizes: number[]; now: string };
      expect(sizes.sizes[0]).toBe(45);
      expect(sizes.sizes.at(-1)).toBe(45);
      expect(sizes.now).toBe('45');
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'with scripting off, a card form posts its move natively',
    async () => {
      const tab = browser?.page ?? expect.unreachable('no browser');
      await tab.scripting(false);
      await tab.evaluate(`location.href = ${JSON.stringify(`${base}/forms`)}`);
      await tab.waitFor(
        'document.getElementById("submit-a") !== null',
        'the no-script form',
        MOUNT_MS,
      );
      await tab.evaluate(`document.querySelector('select').value = 'doing'`);
      await tab.click('#submit-a');
      await tab.waitFor(
        'document.body.textContent.includes("moved")',
        'the post to land',
        MOUNT_MS,
      );
      await tab.scripting(true);
      expect(posted).toEqual(['id=a&fromGroup=todo&toGroup=doing']);
    },
    HOOK_TIMEOUT_MS,
  );
});
