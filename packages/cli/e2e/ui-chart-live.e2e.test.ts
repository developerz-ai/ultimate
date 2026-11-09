// The chart kit live, in a real Chrome at a 390px phone width on the `scifi` preset: a LineChart
// whose window moves sixty times (a minute of one-second ticks, driven, never waited for) keeps a
// focused point's node, its focus and its readout; the page never scrolls sideways; nothing is
// announced; and under `dir="rtl"` an edge point's readout stays inside the plot. Skips with no
// Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import type { SleepClock } from '@ultimat3/core';
import { stylesFor } from '@ultimat3/render/server';
import { E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import type { ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';
import { buildIslands } from '../src/island-bundle';
import type { FixtureApp } from '../src/templates/island-fixture';
import { fixtureAppRoot } from '../src/templates/island-fixture';

const FILE = 'apps/web/site/run-health.island.tsx';
const VIEWPORT = { width: 390, height: 760 } as const;
const TICKS = 60;

/**
 * A live dashboard in one island: a focusable LineChart over irregular samples (`at`), a StatTile
 * whose error rate is bad when it rises, a LiveIndicator — in a Grid. `window.__tick()` is one
 * live update: the next sample through `liveWindow`, so the oldest key leaves and the rest stay.
 */
const ISLAND = `import {
  createContext, createEffect, createMemo, createRoot, createSignal, onCleanup, useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { Grid, LineChart, LiveIndicator, liveWindow, setSolidRuntime, StatTile, deltaOf } from '@ultimat3/ui';

interface Sample { key: string; at: number; value: number | null }
let n = 0;
const next = (): Sample => {
  n += 1;
  // Irregular: every fifth sample arrives late, and every seventh is unknown.
  return { key: 't' + n, at: n * 1000 + (n % 5 === 0 ? 400 : 0), value: n % 7 === 0 ? null : (n * 37) % 11 };
};

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup, createRoot });
  let start: Sample[] = [];
  for (let i = 0; i < 20; i += 1) start = [...liveWindow(start, next(), { max: 120 })];
  const [samples, setSamples] = createSignal<readonly Sample[]>(start);
  (window as unknown as { __tick: () => void }).__tick = () =>
    setSamples(liveWindow(samples(), next(), { max: 120 }));
  render(
    () => (
      <Grid minColumn="10rem">
        <LiveIndicator state="live" />
        <StatTile label="Error rate" value="2.4%" stat="errors" delta={deltaOf(2.4, 2)} goodWhen="down" />
        <LineChart
          label="Run time"
          focusable
          keys={samples().map((s) => s.key)}
          at={samples().map((s) => s.at)}
          series={[{ label: 'Seconds', values: samples().map((s) => s.value), tone: 'warning' }]}
        />
      </Grid>
    ),
    el,
  );
  document.body.dataset.ready = '';
}
`;

const page = (url: string, css: string, brand: string): string => `<!doctype html><html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>live</title>
<style>${css}</style>${brand}<script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)));
</script></body></html>`;

const FRAME = 'await new Promise((done) => requestAnimationFrame(done));';

const PROBE = `(async () => {
  ${FRAME}
  const hits = () => [...document.querySelectorAll('[data-hit]')];
  const point = hits().at(-2);
  point.focus();
  const id = point.dataset.hit;
  const bubble = (hit) => hit.querySelector('[data-readout]');
  const shown = (hit) => getComputedStyle(bubble(hit)).visibility === 'visible';
  const readoutBefore = shown(point);
  for (let i = 0; i < ${TICKS}; i += 1) { window.__tick(); ${FRAME} }
  const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
    .map((region) => region.textContent.trim()).filter((text) => text !== '');
  const kept = {
    id,
    focusedId: document.activeElement && document.activeElement.dataset.hit,
    sameNode: document.activeElement === point && point.isConnected,
    readoutBefore,
    readoutAfter: shown(point),
  };
  const fits = document.documentElement.scrollWidth <= window.innerWidth;

  document.documentElement.dir = 'rtl';
  ${FRAME}
  const edge = hits()[0];
  edge.focus();
  ${FRAME}
  const box = edge.parentElement.parentElement.getBoundingClientRect();
  const read = bubble(edge).getBoundingClientRect();
  const rtl = { inside: read.left >= box.left - 1 && read.right <= box.right + 1, shown: shown(edge) };
  return JSON.stringify({ errors: window.__errors, kept, fits, live, rtl });
})()`;

const clock: SleepClock = {
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
const GLOBAL = join(import.meta.dir, '..', '..', 'ui', 'src', 'global.scss');

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const SHOT_TIMEOUT_MS = 20_000;
const BUILD_MS = 30_000;
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + 6 * SHOT_TIMEOUT_MS;

interface Probe {
  readonly errors: readonly string[];
  readonly kept: {
    readonly id: string;
    readonly focusedId: string | null;
    readonly sameNode: boolean;
    readonly readoutBefore: boolean;
    readonly readoutAfter: boolean;
  };
  readonly fits: boolean;
  readonly live: readonly string[];
  readonly rtl: { readonly inside: boolean; readonly shown: boolean };
}

describe.skipIf(chrome === undefined && !required)('a live chart at 390px on scifi', () => {
  let app: FixtureApp | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  let probe: Probe | undefined;

  beforeAll(async () => {
    app = await fixtureAppRoot('ui-chart-live', [{ path: FILE, contents: ISLAND }]);
    const bundle = await buildIslands(app.path, { only: FILE });
    const chunk = bundle.chunks[0] ?? expect.unreachable(`no chunk was built for ${FILE}`);
    const global = sass.compileString(await Bun.file(GLOBAL).text(), {
      url: Bun.pathToFileURL(GLOBAL),
    });
    const brand = brandStyleTag(defineTheme({ preset: 'scifi' }));
    const document = page(chunk.url, `${global.css}\n${stylesFor('site')}`, brand);
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
      name: 'ui chart live',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    await session.page.goto(`http://localhost:${String(server.port)}/`);
    await session.page.waitFor('body[data-ready]', { state: 'attached' });
    probe = JSON.parse(String(await session.page.evaluate(PROBE))) as Probe;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
    app?.[Symbol.dispose]();
  }, E2E_BROWSER_OPEN_MS);

  test('mounting and sixty ticks throw nothing', () => {
    expect(probe?.errors).toEqual([]);
  });

  test('a focused point keeps its node, its focus and its readout through every tick', () => {
    expect(probe?.kept.focusedId).toBe(probe?.kept.id ?? 'no id');
    expect(probe?.kept.sameNode).toBe(true);
    expect(probe?.kept.readoutBefore).toBe(true);
    expect(probe?.kept.readoutAfter).toBe(true);
  });

  test('the page never scrolls sideways, and no tick is announced', () => {
    expect(probe?.fits).toBe(true);
    expect(probe?.live).toEqual([]);
  });

  test('under dir="rtl" an edge point opens its readout inside the plot', () => {
    expect(probe?.rtl.shown).toBe(true);
    expect(probe?.rtl.inside).toBe(true);
  });
});
