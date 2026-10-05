// `@ultimat3/ui`'s `as` prop inside a REAL island in a real Chrome (#488). The island build compiles
// `.tsx` with Solid's transform, which reads a capitalised `<Tag>` as a component and calls it — a
// root chosen through `as` threw `e is not a function` on mount while the server render was fine.
// `intrinsic-root.test.ts` in ui refuses the pattern in source; this is the mount a browser runs.
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

const FILE = 'apps/web/site/as-prop.island.tsx';

/**
 * Every layout component with an `as` prop, each asked for a non-default root, and the two that
 * choose a heading element from a `level` — the same bug through `headingTag`.
 */
const ISLAND = `import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext } from 'solid-js';
import { render } from 'solid-js/web';
import {
  Accordion,
  Card,
  Container,
  Grid,
  PageHeader,
  Section,
  Stack,
  Text,
  setSolidRuntime,
} from '@ultimat3/ui';

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  render(
    () => (
      <Container as="main">
        <PageHeader title="Dashboard" level={2} />
        <Accordion level={4} items={[{ id: 'one', title: 'Question', panel: 'Answer' }]} />
        <Section as="article" title="Feed" level={3}>
          <Grid as="ul">
            <Card as="li">
              <Text as="p">card body</Text>
            </Card>
          </Grid>
          <Stack as="nav">
            <Text as="strong">stacked</Text>
          </Stack>
        </Section>
      </Container>
    ),
    el,
  );
}
`;

/** Errors recorded from the first byte, and the island imported the way a page's runtime does. */
const documentFor = (url: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>as</title><script>
window.__errors = [];
addEventListener('error', (event) => window.__errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
</script></head><body><div id="root"></div><script type="module">
import(${JSON.stringify(url)})
  .then((island) => island.mount(document.getElementById('root'), {}))
  .catch((error) => window.__errors.push(String(error && error.stack ? error.stack : error)))
  .finally(() => { window.__done = true; });
</script></body></html>`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';

/** The island build: what this hook gave it beyond the open before the open was budgeted. */
const BUILD_MS = 30_000;
const MOUNT_MS = 20_000;
/** The open's whole designed budget, the build, then the `goto`, the mount and two reads. */
const HOOK_TIMEOUT_MS = E2E_BROWSER_OPEN_MS + BUILD_MS + MOUNT_MS + 3 * DEFAULT_CDP_TIMEOUT_MS;

describe.skipIf(chrome === undefined && !required)(
  'ui `as` roots and `level` headings mount inside an island',
  () => {
    let app: FixtureApp | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let browser: E2eBrowser | undefined;
    let errors: readonly string[] = [];
    let shape: Readonly<Record<string, string | null>> = {};

    beforeAll(async () => {
      app = await fixtureAppRoot('ui-as-prop', [{ path: FILE, contents: ISLAND }]);
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
      shape = JSON.parse(
        String(
          await browser.page.evaluate(`JSON.stringify(Object.fromEntries(
          ['main', 'main > article', 'article h3', 'ul > li', 'li p', 'nav > strong', 'header h2', 'summary h4'].map((selector) => {
            const found = document.querySelector('#root ' + selector);
            return [selector, found === null ? null : found.textContent];
          })))`),
        ),
      );
    }, HOOK_TIMEOUT_MS);

    // THE close: the connection, the Chrome process and its profile directory, then the fixture.
    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
      app?.[Symbol.dispose]();
    }, E2E_BROWSER_OPEN_MS);

    test('mounting throws nothing', () => {
      expect(errors).toEqual([]);
    });

    test('each component renders the element its `as` asked for', () => {
      expect(shape['main']).not.toBeNull();
      expect(shape['main > article']).not.toBeNull();
      expect(shape['article h3']).toBe('Feed');
      expect(shape['ul > li']).toBe('card body');
      expect(shape['li p']).toBe('card body');
      expect(shape['nav > strong']).toBe('stacked');
    });

    test('PageHeader and Accordion render the heading their `level` asked for', () => {
      expect(shape['header h2']).toBe('Dashboard');
      expect(shape['summary h4']).toBe('Question');
    });
  },
);
