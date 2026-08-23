// The harness document, asserted against the SEAM it is required to ride: `data-x-entry`,
// `data-x-props` and `@ultimat3/render`'s own hydration runtime. A second mounting mechanism here
// would produce a picture of something no page ever renders, and only reading the emitted markup
// can tell the two apart.

import { describe, expect, test } from 'bun:test';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { defineIslandStates, islandShotTargets } from '@ultimat3/testing';
import { islandBundle } from './island-bundle';
import { harnessPage, ISLAND_HARNESS_PATH, surfaceOf } from './island-harness';
import { islandHarnessRoutes } from './island-harness-route';
import { HARNESS_GLOBAL, harnessScript, readinessProbe } from './island-harness-script';

const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const manifest = defineIslandStates({
  island: ISLAND,
  timeZone: 'Europe/Bucharest',
  now: '2026-03-04T09:00:00.000Z',
  states: [
    {
      id: 'empty-options',
      title: 'the options read answered nothing',
      props: { locales: [], note: 'a </script> in a prop must not end the tag' },
      routes: [{ match: 'GET /api/settings', respond: { kind: 'json', body: { locales: [] } } }],
    },
    // A SECOND state, and it is what makes "the route served the address it was asked for"
    // assertable at all: with one state, a handler that ignored the query would still be right.
    {
      id: 'save-failed',
      title: 'the save came back 500',
      props: { marker: 'the-second-state' },
    },
  ],
});

const target = islandShotTargets(manifest)[0] as ReturnType<typeof islandShotTargets>[number];
const state = manifest.states[0] as (typeof manifest.states)[number];

const page = (): string => harnessPage({ target, state, entry: '/islands/settings-abc.js' });

describe('unit · the harness rides the seam the framework already has', () => {
  test('the chunk arrives through data-x-entry and the props through data-x-props', () => {
    const html = page();

    expect(html).toContain('data-x-island="settings"');
    expect(html).toContain('data-x-entry="/islands/settings-abc.js"');
    expect(html).toContain('<script type="application/json" data-x-props="settings">');
    // The runtime that reads both. Without it the page renders the server shell and nothing else,
    // and the picture is of markup no browser ever hydrated.
    expect(html).toContain('m.mount(el,props)');
  });

  test('the theme is the document attribute an app already switches on', () => {
    expect(page()).toContain('data-theme="light"');
  });

  /**
   * A prop is author data and the document is markup: a `</script>` inside one ends the tag and
   * the rest of the page is parsed as text. `emitIslandProps` is what escapes it, which is the
   * second reason this page uses render's emitter rather than building the tag itself.
   */
  test('a prop holding a closing script tag does not end the document', () => {
    const html = page();
    expect(html).not.toContain('</script> in a prop');
    expect(html).toContain('a \\u003c/script\\u003e in a prop');
  });

  test('the surface decides the stylesheet, so a site island is not shown app CSS', () => {
    expect(surfaceOf(ISLAND)).toBe('app');
    expect(surfaceOf('apps/web/site/pricing/contact-sales.island.tsx')).toBe('site');
    expect(surfaceOf('nonsense')).toBeNull();
  });

  // Every rule in the frame is about what a reviewer sees: a picture taken mid-transition is a
  // picture of a moment no user experiences, and a blinking caret makes two identical runs differ.
  test('animations, transitions and the caret are off', () => {
    const html = page();
    expect(html).toContain('animation:none !important');
    expect(html).toContain('transition:none !important');
    expect(html).toContain('caret-color:transparent !important');
  });

  test('no raw colour reaches the frame — the background is a semantic token', () => {
    expect(page()).toContain('background:rgb(var(--color-bg) / 1)');
  });
});

describe('unit · the prelude seals the network and pins the clock', () => {
  const script = (): string =>
    harnessScript({ stubs: state.routes, now: target.now, timeZone: target.timeZone });

  test('fetch, WebSocket, EventSource and XHR are all replaced', () => {
    const source = script();
    for (const surface of [
      'window.fetch=',
      'window.WebSocket=',
      'window.EventSource=',
      'window.XMLHttpRequest=',
    ]) {
      expect(source).toContain(surface);
    }
  });

  test('the state routes are embedded, with < escaped so no body can end the tag', () => {
    const source = harnessScript({
      stubs: [{ match: 'GET /a', respond: { kind: 'json', body: { x: '</script>' } } }],
      now: target.now,
      timeZone: 'UTC',
    });
    expect(source).toContain('GET /a');
    expect(source).not.toContain('</script>');
    expect(source).toContain('\\u003c/script>');
  });

  /**
   * The zone is pinned as well as the instant, and that is the half a harness forgets: freeze the
   * moment and leave the zone ambient and the same state renders `12:00` on one machine and
   * `14:00` on the next, so the review diff reports a change that never happened.
   */
  test('both halves of the clock are in the page, the zone included', () => {
    const source = script();
    expect(source).toContain(String(Date.parse('2026-03-04T09:00:00.000Z')));
    expect(source).toContain('"Europe/Bucharest"');
    expect(source).toContain('Intl.DateTimeFormat=ShotDTF');
  });

  test('readiness is quiet, not zero in flight', () => {
    const source = script();
    // Counting frames with an unchanged ACTIVITY counter, never waiting for nothing in flight: a
    // `pending` fixture never settles, so the second rule would hang on a state declared on purpose.
    expect(source).toContain('requestAnimationFrame(tick)');
    expect(source).toContain('W.activity');
    expect(source).not.toContain('inflight===0');
  });
});

describe('unit · the probe reports every fact a picture cannot carry', () => {
  test('one expression, and it names the crop target the manifest declared', () => {
    const probe = readinessProbe('[data-settings]');
    expect(probe).toContain('"[data-settings]"');
    expect(probe).toContain(HARNESS_GLOBAL);
    for (const fact of [
      'harness:',
      'ready:',
      'unstubbed:',
      'attached:',
      'mounted:',
      'failed:',
      'filled:',
      'box:',
    ]) {
      expect(probe).toContain(fact);
    }
  });
});

/**
 * The route, called the way `x dev` calls it. Its one refusal is an island or a state THIS process
 * does not know, which can only mean the two processes disagree — `x shot` computed its picture
 * list from the files on disk and this server was booted against an older set. Everything else
 * falls back rather than throwing: a page that renders an error over a typo turns a typo into a
 * screenshot of the framework.
 */
describe('unit · the harness route serves one address and refuses only what it cannot know', () => {
  const chunk = {
    file: ISLAND,
    moduleId: 'settings',
    url: '/islands/settings-abc.js',
    code: 'export function mount(){}',
    bytes: 25,
  };
  const routes = islandHarnessRoutes({
    islands: () => islandBundle([chunk]),
    states: () => Promise.resolve([manifest]),
  });

  const call = async (query: string): Promise<Response> => {
    const url = new URL(`http://dev.test${ISLAND_HARNESS_PATH}${query}`);
    const route = routes[0] as (typeof routes)[number];
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    return route.handler(new UltimateRequest(new Request(url), ctx), ctx);
  };

  test('the declared address renders the island with its state props', async () => {
    const response = await call(target.query);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data-x-entry="/islands/settings-abc.js"');
    expect(body).toContain('data-x-props="settings"');
  });

  // Total on the way in: a mistyped theme is not an error page, it is the default theme. The
  // component is still what gets photographed, which is the whole reason `parseIslandAddress`
  // falls back instead of throwing.
  test('the address decides which state is served, not the first one declared', async () => {
    const second = islandShotTargets(manifest).find((one) => one.state === 'save-failed');
    const body = await (await call((second as typeof target).query)).text();
    expect(body).toContain('the-second-state');
    expect(body).not.toContain('a \\u003c/script');
    // The document names its own subject, so a page open in a tab says which picture it is — and
    // it is the one assertion that fails if the route resolves the props and the TARGET separately.
    expect(body).toContain('<title>settings · save-failed · light</title>');
  });

  test('a mistyped theme still shows the component', async () => {
    const response = await call(`${target.query.replace('theme=light', 'theme=neon')}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-theme="light"');
  });

  test('a state this process does not know is the one refusal, and it names the ones it has', async () => {
    const response = await call(`?island=${encodeURIComponent(ISLAND)}&state=nope&theme=light`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe('X_SHOT_ISLAND_UNPHOTOGRAPHABLE');
    expect(body.error.fix).toContain('--state empty-options');
  });

  test('an island with no built chunk says so rather than serving a document that cannot boot', async () => {
    const empty = islandHarnessRoutes({
      islands: () => islandBundle([]),
      states: () => Promise.resolve([manifest]),
    });
    const url = new URL(`http://dev.test${ISLAND_HARNESS_PATH}${target.query}`);
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    const response = await (empty[0] as (typeof empty)[number]).handler(
      new UltimateRequest(new Request(url), ctx),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});
