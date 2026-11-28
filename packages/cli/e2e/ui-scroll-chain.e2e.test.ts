// `@ultimat3/ui` chains wheel scroll to the page (#1289): a wheel over the in-flow `AppShell`
// sidebar or over a short `Table`, on a page taller than the viewport, moves the WINDOW, while an
// open `Drawer` still traps its own scroll. Chrome 144+ honours `overscroll-behavior: contain` on a
// box with nothing to scroll, which is the only engine the bug shows on: below 144 the suite SKIPS
// by name rather than pass for nothing. Real component CSS and a real `Input.dispatchMouseEvent`
// wheel. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { registeredStylesheets } from '@ultimat3/render/server';
import type { CdpConnection, LaunchedBrowser } from '@ultimat3/scraping/cdp';
import { findChrome, LAUNCH_TEST_MS, launchReady } from '@ultimat3/scraping/cdp';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/scroll-chain.island.tsx';
const UI = join(import.meta.dir, '..', '..', 'ui', 'src');
/** The first Chrome that honours `contain` on a box with no overflow. */
const FIRST_AFFECTED_MAJOR = 144;
const STEP_MS = 20_000;
const SETTLE_MS = 1_500;

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
import { AppShell, Drawer, NavList, Table, setSolidRuntime } from '@ultimat3/ui';

const PLACES = [
  { label: 'Feed', href: '/feed', icon: '·' },
  { label: 'Runs', href: '/runs', icon: '·' },
];

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const drawer = new URLSearchParams(location.search).get('drawer') === '1';
  render(
    () => (
      <AppShell header={<strong>Chain</strong>} sidebar={<NavList items={PLACES} currentHref="/feed" />}>
        <Table caption="Runs">
          <thead><tr><th>Name</th></tr></thead>
          <tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody>
        </Table>
        <div style={{ 'block-size': '3000px' }}>tall</div>
        <Drawer open={drawer} title="Panel" onClose={() => undefined}>
          <div id="drawer-fill" style={{ 'block-size': '2000px' }}>long</div>
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

const documentFor = (url: string, css: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><style>${css}</style><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
</script></head>
<body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

/** `Google Chrome 158.0.8127.88` → 158; `undefined` when the binary says nothing parseable. */
const majorOf = async (executable: string | undefined): Promise<number | undefined> => {
  if (executable === undefined) return undefined;
  const run = Bun.spawn([executable, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const text = await new Response(run.stdout).text();
  const found = /(\d+)\.\d+\.\d+\.\d+/.exec(text);
  return found?.[1] === undefined ? undefined : Number(found[1]);
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const major = await majorOf(chrome);
const tooOld = major !== undefined && major < FIRST_AFFECTED_MAJOR;
const skipReason = tooOld
  ? `SKIPPED: Chrome ${String(major)} predates ${String(FIRST_AFFECTED_MAJOR)}, the first to trap the wheel on a box with nothing to scroll (#1289); this suite cannot fail there`
  : '';

describe.skipIf((chrome === undefined && !required) || tooOld)(
  `wheel chaining to the page (#1289)${tooOld ? ` — ${skipReason}` : ''}`,
  () => {
    let app: FixtureApp | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let browser: LaunchedBrowser | undefined;
    let session: string | undefined;

    const connection = (): CdpConnection =>
      browser?.connection ?? expect.unreachable('no browser launched');
    const call = (method: string, params: Record<string, unknown> = {}) =>
      connection().send(method, params, session, STEP_MS);
    const read = async (expression: string): Promise<unknown> => {
      const answer = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return (answer.result?.['result'] as { value?: unknown } | undefined)?.value;
    };
    const until = async (expression: string, what: string): Promise<void> => {
      const started = performance.now();
      while ((await read(expression)) !== true) {
        if (performance.now() - started > STEP_MS) expect.unreachable(`timed out on ${what}`);
        // real-clock: the poll waits on Chrome, another process, which no fake timer moves.
        await Bun.sleep(25);
      }
    };
    const visit = async (query: string): Promise<void> => {
      await call('Page.navigate', { url: `http://localhost:${String(server?.port)}/${query}` });
      await until('window.__done === true', 'the island to mount');
      expect(JSON.parse(String(await read('JSON.stringify(window.__errors)')))).toEqual([]);
    };
    /** A wheel at the middle of `selector`'s top edge region, as a person's pointer sends it. */
    const wheelOver = async (selector: string): Promise<void> => {
      const at = (await read(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return [r.left + r.width / 2, r.top + Math.min(r.height / 2, 40)];
      })()`)) as readonly [number, number];
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
      await call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: at[0],
        y: at[1],
        deltaX: 0,
        deltaY: 300,
      });
      // real-clock: the compositor applies a wheel after the call returns.
      await Bun.sleep(SETTLE_MS);
    };

    beforeAll(async () => {
      app = await fixtureAppRoot('ui-scroll-chain', [{ path: FILE, contents: ISLAND }]);
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
      if (chrome === undefined)
        expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
      browser = await launchReady({ executable: chrome, timeoutMs: STEP_MS });
      const created = await connection().send('Target.createTarget', { url: 'about:blank' });
      const targetId = String(created.result?.['targetId']);
      const attached = await connection().send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      session = String(attached.result?.['sessionId']);
      await call('Emulation.setDeviceMetricsOverride', {
        width: 1200,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }, LAUNCH_TEST_MS + 60_000);

    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
      app?.[Symbol.dispose]();
    }, LAUNCH_TEST_MS);

    test('the browser under test is the one the skip gate measured', async () => {
      const answer = await connection().send('Browser.getVersion');
      const product = String(answer.result?.['product']);
      expect(Number(/\/(\d+)\./.exec(product)?.[1])).toBeGreaterThanOrEqual(FIRST_AFFECTED_MAJOR);
    });

    test(
      'a wheel over the in-flow sidebar scrolls the page',
      async () => {
        await visit('');
        expect(await read('scrollY')).toBe(0);
        await wheelOver('nav[popover]');
        expect(Number(await read('scrollY'))).toBeGreaterThan(0);
      },
      STEP_MS * 2,
    );

    test(
      'a wheel over a short table scrolls the page',
      async () => {
        await visit('');
        expect(await read('scrollY')).toBe(0);
        await wheelOver('section[aria-label="Runs"]');
        expect(Number(await read('scrollY'))).toBeGreaterThan(0);
      },
      STEP_MS * 2,
    );

    test(
      'an open Drawer still traps: a wheel at the end of its body leaves the page where it was',
      async () => {
        await visit('?drawer=1');
        await read(
          `(() => { const d = document.querySelector('dialog[open]'); const b = [...d.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY === 'auto'); b.scrollTop = b.scrollHeight; return true; })()`,
        );
        await wheelOver('dialog[open] #drawer-fill');
        expect(await read('scrollY')).toBe(0);
        // A modal makes the page inert to a wheel in Chrome either way, so the wheel alone cannot
        // tell a trapping body from a chaining one: the computed style is the contract.
        expect(
          await read(
            `getComputedStyle(document.querySelector('#drawer-fill').parentElement).overscrollBehaviorY`,
          ),
        ).toBe('contain');
      },
      STEP_MS * 2,
    );
  },
);
