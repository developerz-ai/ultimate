// `VirtualList` inside a REAL island in a real Chrome at a 390px phone width: 10,000 rows mount
// fewer than 100 `<li>`, a live prepend leaves the focused row focused and where the reader saw it,
// and a reader scrolled up a following list is not moved by an append. Skips with no Chrome,
// unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { stylesFor } from '@ultimat3/render/server';
import { E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import type { ShotClock, ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/virtual-list.island.tsx';
const VIEWPORT = { width: 390, height: 700 } as const;
const ROWS = 10_000;

/**
 * Two lists of 10,000 rows in 300px boxes: `#reader` holds still, `#log` follows its end. Each row is
 * a button, so focus is a real thing to keep. `window.__prepend(n)` and `window.__append(n)` are
 * the live updates, each minting fresh keys. `#capped` is sized only by a CAP on its own class
 * (`max-block-size`), in a parent of no height: the box must bound itself under it.
 */
const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { setSolidRuntime, VirtualList } from '@ultimat3/ui';

interface Row { id: string; text: string }
let minted = 0;
const make = (count: number, tag: string): Row[] =>
  Array.from({ length: count }, () => { minted += 1; return { id: tag + minted, text: 'Row ' + tag + minted }; });

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const [reader, setReader] = createSignal<Row[]>(make(${ROWS}, 'r'));
  const [log, setLog] = createSignal<Row[]>(make(${ROWS}, 'l'));
  const w = window as unknown as Record<string, (count: number) => void>;
  w.__prepend = (count) => setReader([...make(count, 'p'), ...reader()]);
  w.__append = (count) => setLog([...log(), ...make(count, 'a')]);
  const list = (id: string, rows: () => Row[], follow: boolean) => (
    <div id={id} style={{ height: '300px', display: 'grid' }}>
      <VirtualList
        items={rows()}
        itemKey={(row: Row) => row.id}
        renderItem={(row: Row) => <button type="button" data-row={row.id}>{row.text}</button>}
        estimate={40}
        follow={follow}
        label={id}
      />
    </div>
  );
  const capped = (
    <div id="capped">
      <VirtualList
        items={make(${ROWS}, 'c')}
        itemKey={(row: Row) => row.id}
        renderItem={(row: Row) => <span>{row.text}</span>}
        estimate={40}
        label="capped"
        class="capped"
      />
    </div>
  );
  render(() => <>{list('reader', reader, false)}{list('log', log, true)}{capped}</>, el);
  document.body.dataset.ready = '';
}
`;

const page = (url: string, css: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>virtual</title>
<style>${css}
.capped { max-block-size: 300px; }</style><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)));
</script></body></html>`;

/**
 * Frames until nothing moves for three in a row: each measured row can mount the next, so "two
 * frames" is a guess and this is the condition. Bounded, so a list that never settles fails here.
 */
const SETTLE = `await (async () => {
  let still = 0;
  let last = '';
  for (let frame = 0; frame < 120 && still < 3; frame += 1) {
    await new Promise((done) => requestAnimationFrame(done));
    const now = [...document.querySelectorAll('ul')].map((list) => list.parentElement.scrollTop + ':' + list.children.length).join();
    still = now === last ? still + 1 : 0;
    last = now;
  }
})();`;

const box = (id: string): string => `document.querySelector('#${id} ul').parentElement`;

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
const THEME = join(import.meta.dir, '..', '..', 'ui', 'src', 'tokens', 'theme.scss');

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const SHOT_TIMEOUT_MS = 20_000;
const BUILD_MS = 30_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + 12 * SHOT_TIMEOUT_MS;

interface Probe {
  readonly errors: readonly string[];
  readonly mounted: { readonly reader: number; readonly log: number; readonly capped: number };
  readonly cappedHeight: number;
  readonly setsize: string | null;
  readonly prepend: {
    readonly focusBefore: string | null;
    readonly focusAfter: string | null;
    readonly topBefore: number;
    readonly topAfter: number;
    readonly sameNode: boolean;
  };
  readonly append: {
    readonly topBefore: number;
    readonly topAfter: number;
    readonly toEnd: boolean;
  };
  readonly follow: { readonly atEndAfter: boolean };
}

describe.skipIf(chrome === undefined && !required)('VirtualList in a real island at 390px', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  let probe: Probe | undefined;

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-virtual-list', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    const theme = sass.compileString(await Bun.file(THEME).text(), {
      url: Bun.pathToFileURL(THEME),
    });
    const document = page(chunk.url, `${theme.css}\n${stylesFor('site')}`);
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const asset = bundle.assetAt(new URL(request.url).pathname);
        if (asset !== undefined) {
          return new Response(asset.code, { headers: { 'content-type': 'text/javascript' } });
        }
        return new Response(document, { headers: { 'content-type': 'text/html' } });
      },
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    session = await cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT }).open({
      name: 'ui virtual list',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    await session.page.goto(`http://localhost:${String(server.port)}/`);
    await session.page.waitFor('body[data-ready]', { state: 'attached' });
    const raw = await session.page.evaluate(`(async () => {
      ${SETTLE}
      const count = (id) => document.querySelectorAll('#' + id + ' li').length;
      const mounted = { reader: count('reader'), log: count('log'), capped: count('capped') };
      const cappedHeight = ${box('capped')}.clientHeight;
      const setsize = document.querySelector('#reader li').getAttribute('aria-setsize');

      // Prepend: scroll the reader into the middle, focus a row, then 50 rows arrive above it.
      const reader = ${box('reader')};
      reader.scrollTop = 4000;
      ${SETTLE}
      const row = [...reader.querySelectorAll('li')][3];
      const button = row.querySelector('button');
      button.focus();
      const focusBefore = document.activeElement && document.activeElement.dataset.row;
      const topBefore = row.getBoundingClientRect().top;
      window.__prepend(50);
      ${SETTLE}
      const prepend = {
        focusBefore,
        focusAfter: document.activeElement && document.activeElement.dataset.row,
        topBefore,
        topAfter: row.getBoundingClientRect().top,
        sameNode: row.isConnected,
      };

      // Append while scrolled up a following list: the reader is left where they are.
      const log = ${box('log')};
      ${SETTLE}
      log.scrollTop = 2000;
      log.dispatchEvent(new Event('scroll'));
      ${SETTLE}
      const read = [...log.querySelectorAll('li')][4];
      const readKey = read.dataset.key;
      const readTop = read.getBoundingClientRect().top;
      window.__append(20);
      ${SETTLE}
      const append = {
        topBefore: readTop,
        topAfter: log.querySelector('li[data-key="' + readKey + '"]').getBoundingClientRect().top,
        toEnd: document.querySelector('#log button:not([data-row])') !== null,
      };

      // Back at the end, the list follows what arrives.
      log.scrollTop = log.scrollHeight;
      ${SETTLE}
      window.__append(5);
      ${SETTLE}
      ${SETTLE}
      const follow = { atEndAfter: log.scrollHeight - log.scrollTop - log.clientHeight < 2 };
      return JSON.stringify({ errors: window.__errors, mounted, cappedHeight, setsize, prepend, append, follow });
    })()`);
    probe = JSON.parse(String(raw)) as Probe;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test('10,000 rows mount fewer than 100 list items, each told the true count', () => {
    expect(probe?.errors).toEqual([]);
    expect(probe?.mounted.reader).toBeGreaterThan(0);
    expect(probe?.mounted.reader).toBeLessThan(100);
    expect(probe?.mounted.log).toBeLessThan(100);
    expect(probe?.setsize).toBe(String(ROWS));
  });

  test('a box capped only by max-block-size bounds itself: it scrolls, and mounts a screenful', () => {
    // An `auto` grid row grew to every row's height under a cap: the box never scrolled, and the
    // list measured itself as tall as all 10,000 rows and drew each one.
    expect(probe?.cappedHeight).toBeLessThanOrEqual(300);
    expect(probe?.mounted.capped).toBeGreaterThan(0);
    expect(probe?.mounted.capped).toBeLessThan(100);
  });

  test('a live prepend keeps the focused row focused, its node, and its place on screen', () => {
    expect(probe?.prepend.focusBefore).toBeString();
    expect(probe?.prepend.focusAfter).toBe(probe?.prepend.focusBefore ?? null);
    expect(probe?.prepend.sameNode).toBe(true);
    expect(
      Math.abs((probe?.prepend.topAfter ?? 0) - (probe?.prepend.topBefore ?? 1e9)),
    ).toBeLessThan(2);
  });

  test('scrolled up a following list, an append does not move the reader, and offers the end', () => {
    expect(probe?.append.topAfter).toBe(probe?.append.topBefore ?? -1);
    expect(probe?.append.toEnd).toBe(true);
  });

  test('at the end, a following list stays at the end as rows arrive', () => {
    expect(probe?.follow.atEndAfter).toBe(true);
  });
});
