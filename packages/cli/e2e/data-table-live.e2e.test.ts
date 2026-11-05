// `DataTable`'s keyed rows inside a REAL island in a real Chrome: a live update that hands back the
// same object for row `b` must leave its `<tr>` — and the focus and the open "more" inside it —
// exactly where they were. Before keyed rows every tick rebuilt every row: `focus-after=BODY`.
// Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
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

const FILE = 'apps/web/site/live-table.island.tsx';

/**
 * Two rows, a button in each, and a priority-2 column so every row carries a "more" disclosure.
 * `window.__tick(title)` is the live update: a NEW object for `a`, the SAME object for `b`.
 */
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
import { DataTable, setSolidRuntime } from '@ultimat3/ui';

interface Row { id: string; title: string }

export function mount(el: HTMLElement): void {
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  const b: Row = { id: 'b', title: 'B' };
  const [rows, setRows] = createSignal<Row[]>([{ id: 'a', title: 'A' }, b]);
  (window as unknown as { __tick: (title: string) => void }).__tick = (title) =>
    setRows([{ id: 'a', title }, b]);
  render(
    () => (
      <DataTable
        caption="Live"
        rows={rows()}
        rowKey={(row: Row) => row.id}
        columns={[
          { key: 'title', header: 'Title', cell: (row: Row) => <span class="title">{row.title}</span> },
          { key: 'act', header: 'Act', cell: (row: Row) => <button type="button" id={'btn-' + row.id}>go</button> },
          { key: 'note', header: 'Note', priority: 2, cell: (row: Row) => row.id },
        ]}
      />
    ),
    el,
  );
}
`;

/** Errors recorded from the first byte, and the island imported the way a page's runtime does. */
const documentFor = (url: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>live</title><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** One live update, read before and after in the same evaluation, so nothing races the tick. */
const PROBE = `(() => {
  const row = (key) => document.querySelector('#root tr[data-row="' + key + '"]');
  const beforeA = row('a');
  const beforeB = row('b');
  document.getElementById('btn-b').focus();
  beforeB.querySelector('details').open = true;
  const focusBefore = document.activeElement && document.activeElement.id;
  window.__tick('A2');
  const afterB = row('b');
  return JSON.stringify({
    focusBefore,
    focusAfter: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    sameB: afterB === beforeB,
    openB: afterB.querySelector('details').open,
    sameA: row('a') === beforeA,
    titleA: row('a').querySelector('.title').textContent,
    rows: document.querySelectorAll('#root tbody tr').length,
  });
})()`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';

const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
/** The open's whole designed budget, the build, then the `goto`, the mount and two reads. */
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 3 * DEFAULT_CDP_TIMEOUT_MS;

interface Probe {
  readonly focusBefore: string | null;
  readonly focusAfter: string | null;
  readonly sameB: boolean;
  readonly openB: boolean;
  readonly sameA: boolean;
  readonly titleA: string;
  readonly rows: number;
}

describe.skipIf(chrome === undefined && !required)(
  'DataTable keyed rows under a live update',
  () => {
    let app: FixtureApp | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let browser: E2eBrowser | undefined;
    let errors: readonly string[] = [];
    let probe: Probe | undefined;

    beforeAll(async () => {
      app = await fixtureAppRoot('data-table-live', [{ path: FILE, contents: ISLAND }]);
      const bundle = await buildIslands(app.path, { only: FILE });
      const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
      const page = documentFor(chunk.url);
      server = Bun.serve({
        port: 0,
        fetch: (request) => {
          const asset = bundle.assetAt(new URL(request.url).pathname);
          if (asset !== undefined) {
            return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
          }
          return new Response(page, { headers: { 'content-type': 'text/html' } });
        },
      });
      browser = await (required ? openE2eBrowser() : openE2eBrowserIfAvailable());
      if (browser === undefined)
        expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
      await browser.page.goto(`http://localhost:${String(server.port)}/`);
      await browser.page.waitFor(
        'window.__done === true',
        'the island to finish mounting',
        MOUNT_MS,
      );
      errors = JSON.parse(String(await browser.page.evaluate('JSON.stringify(window.__errors)')));
      probe = JSON.parse(String(await browser.page.evaluate(PROBE))) as Probe;
    }, HOOK_TIMEOUT_MS);

    // THE close: the connection, the Chrome process and its profile directory, then the fixture.
    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
      app?.[Symbol.dispose]();
    }, E2E_BROWSER_OPEN_MS);

    test('mounting and the update throw nothing', () => {
      expect(errors).toEqual([]);
      expect(probe?.rows).toBe(2);
    });

    test('an unchanged row keeps its <tr>, its focused button and its open disclosure', () => {
      expect(probe?.focusBefore).toBe('btn-b');
      expect(probe?.sameB).toBe(true);
      expect(probe?.focusAfter).toBe('btn-b');
      expect(probe?.openB).toBe(true);
    });

    test('a changed row keeps its <tr> and redraws its cells', () => {
      expect(probe?.sameA).toBe(true);
      expect(probe?.titleA).toBe('A2');
    });
  },
);
