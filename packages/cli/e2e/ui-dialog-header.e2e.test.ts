// `@ultimat3/ui`'s `Dialog` and `Drawer` headers in a real Chrome at 320px, both writing
// directions: a long title wraps beside the close button and never runs under it, one unbreakable
// word included, and the button keeps its size. Found by an app's UI QA: "Redenumește acest PC"
// ran under the ×. Real component CSS, as `ui-mobile-frame.e2e.test.ts` builds it. Skips with no
// Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import type { SleepClock } from '@ultimat3/core';
import { registeredStylesheets } from '@ultimat3/render/server';
import { findChrome } from '@ultimat3/scraping/cdp';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_BROWSER_OPEN_MS } from '@ultimat3/testing';
import type { ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/dialog-header.island.tsx';
const VIEWPORT = { width: 320, height: 640 } as const;
const UI = join(import.meta.dir, '..', '..', 'ui', 'src');

const TITLES = [
  'Redenumește acest PC',
  'Redenumește acest calculator personal din biroul de contabilitate',
  'Configurațiadispozitivuluiprincipalfărăspații',
] as const;

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
import { Dialog, Drawer, setSolidRuntime } from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  const params = new URLSearchParams(location.search);
  const title = params.get('title') ?? '';
  const kind = params.get('kind');
  render(
    () =>
      kind === 'drawer' ? (
        <Drawer open title={title} onClose={() => undefined}>
          <p>Body</p>
        </Drawer>
      ) : (
        <Dialog open title={title} onClose={() => undefined}>
          <p>Body</p>
        </Dialog>
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

const documentFor = (url: string, css: string, dir: 'ltr' | 'rtl'): string => `<!doctype html>
<html lang="ro" dir="${dir}"><head><meta charset="utf-8">
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

/** Where the title's GLYPHS are — a Range, not the h2's box, which overflowing text escapes. */
const GEOMETRY = `JSON.stringify((() => {
  const dialog = document.querySelector('dialog[open]');
  const title = dialog.querySelector('h2');
  const close = dialog.querySelector('header button');
  const range = document.createRange();
  range.selectNodeContents(title);
  const glyphs = [...range.getClientRects()];
  const button = close.getBoundingClientRect();
  return {
    glyphLeft: Math.min(...glyphs.map((r) => r.left)),
    glyphRight: Math.max(...glyphs.map((r) => r.right)),
    lines: new Set(glyphs.map((r) => Math.round(r.top))).size,
    button: { left: button.left, right: button.right, width: button.width, height: button.height },
    panel: dialog.getBoundingClientRect().toJSON(),
    sideways: document.documentElement.scrollWidth > innerWidth,
  };
})())`;

interface Geometry {
  readonly glyphLeft: number;
  readonly glyphRight: number;
  readonly lines: number;
  readonly button: { left: number; right: number; width: number; height: number };
  readonly panel: { left: number; right: number };
  readonly sideways: boolean;
}

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

describe.skipIf(chrome === undefined && !required)('a modal header at 320px', () => {
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

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-dialog-header', [{ path: FILE, contents: ISLAND }]);
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
      name: 'ui dialog header',
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

  for (const kind of ['dialog', 'drawer'] as const) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(
        `${kind}, ${dir}: every title stays beside the close button, which keeps its size`,
        async () => {
          for (const title of TITLES) {
            const query = new URLSearchParams({ kind, title }).toString();
            await page().goto(`http://localhost:${String(server?.port)}/${dir}?${query}`);
            await until('window.__done === true', 'the island to mount');
            expect(JSON.parse(String(await read('JSON.stringify(window.__errors)')))).toEqual([]);
            const seen = JSON.parse(String(await read(GEOMETRY))) as Geometry;
            const where = `${kind} ${dir} "${title}"`;
            if (dir === 'ltr') {
              expect(`${where}: ${seen.glyphRight <= seen.button.left}`).toBe(`${where}: true`);
            } else {
              expect(`${where}: ${seen.glyphLeft >= seen.button.right}`).toBe(`${where}: true`);
            }
            // `sm` is 1.75rem: a squeezed button is a smaller tap target and a clipped glyph.
            expect(seen.button.width).toBe(28);
            expect(seen.button.height).toBe(28);
            expect(seen.glyphLeft).toBeGreaterThanOrEqual(seen.panel.left);
            expect(seen.glyphRight).toBeLessThanOrEqual(seen.panel.right);
            expect(seen.sideways).toBe(false);
          }
        },
        STEP_MS * 3,
      );
    }
  }

  test(
    'a long title wraps instead of running on',
    async () => {
      const query = new URLSearchParams({ kind: 'dialog', title: TITLES[1] }).toString();
      await page().goto(`http://localhost:${String(server?.port)}/ltr?${query}`);
      await until('window.__done === true', 'the island to mount');
      const seen = JSON.parse(String(await read(GEOMETRY))) as Geometry;
      expect(seen.lines).toBeGreaterThan(1);
    },
    STEP_MS * 3,
  );
});
