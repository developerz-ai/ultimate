// Milestone 8's claim, performed: a tab opened on build 0 stays open across SIX deploys, each one
// a real edit to an island's source (a new chunk hash, never `BUILD_ID` alone), and its first click
// after the sixth still boots build 0's island — chunk 200, no 404, and the page told by its service
// worker that a newer build exists. The same run without `assets.retain` meets the dead island.
//
//   bun test packages/cli/e2e/six-deploys.e2e.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { E2eBrowser } from '@ultimat3/testing';
import {
  E2E_BROWSER_CLOSE_MS,
  E2E_BROWSER_OPEN_MS,
  e2eFixtures,
  e2ePage,
  findChrome,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
  paced,
} from '@ultimat3/testing';
import { pump, reapIn, waitFor } from '../src/dev-live-fixture';
import { processRoot } from '../src/process-root-fixture';

const DEPLOYS = 6;
const TIMEOUT_MS = paced(E2E_BROWSER_OPEN_MS + 240_000);
const BASE = processRoot(join(import.meta.dir, '..', '.six-deploys-e2e-fixture'));

/** One app, two shapes: with the retention window over a local disk, or as it shipped before 30. */
const files = (root: string, retain: boolean): Readonly<Record<string, string>> => ({
  'package.json': JSON.stringify({ name: 'six-deploys', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({
  name: 'six-deploys',
  ${retain ? `assets: { retain: { disk: 'deploys', builds: ${DEPLOYS + 1} } },` : ''}
  pwa: {
    enabled: true,
    offline: { fallback: '/offline' },
    name: 'Six deploys',
    colors: {
      light: { themeColor: '#101010', backgroundColor: '#ffffff' },
      dark: { themeColor: '#101010', backgroundColor: '#000000' },
    },
  },
});
`,
  'apps/web/shared/storage.ts': `import { defineStorage, localDriver } from '@ultimat3/storage';
export const storage = defineStorage({ disks: { deploys: localDriver({ root: ${JSON.stringify(join(root, 'disk'))} }) } });
`,
  'apps/web/site/page.tsx': `import { defineRoute, island } from '@ultimat3/render';
import '../shared/storage';

const Counter = island({ src: './counter.island.tsx' });

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'interaction',
  offline: 'network-only',
  budget: { js: '20kb' },
  meta: () => ({ title: 'Six deploys', description: 'a tab left open across six deploys' }),
});

export function Page() {
  return <main><Counter>inert</Counter></main>;
}
`,
  'apps/web/site/offline/page.tsx': `import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  meta: () => ({ title: 'Offline', description: 'no network' }),
});

export function Page() {
  return <main>offline</main>;
}
`,
  'apps/web/server.ts': `import { join } from 'node:path';
import { runRole } from '@ultimat3/cli/serve';

if (import.meta.main) await runRole({ root: join(import.meta.dir, '..', '..'), env: Bun.env });
`,
});

/**
 * The island's source at build `n`: the only line that changes, so each deploy is a new chunk. A
 * `realtime` island reaches `@ultimat3/realtime`, so it is built as a wrapper that first imports the
 * page runtime chunk (`/islands/page-runtime.<hash>.js`), which must outlive the deploy as well.
 */
const island = (n: number, realtime: boolean): string =>
  realtime
    ? `import { useConnection } from '@ultimat3/realtime';
export function mount(el: HTMLElement): void {
  el.textContent = typeof useConnection === 'function' ? 'build ${n}' : 'no realtime';
}
`
    : `export function mount(el: HTMLElement): void { el.textContent = 'build ${n}'; }\n`;

/** Every response the page saw, from its own resource timing: the request log. */
const REQUEST_LOG = `performance.getEntriesByType('resource')
  .map((e) => ({ path: new URL(e.name).pathname, status: e.responseStatus }))`;

/** Records every `AppUpdateAvailable` the service worker posts, from now on. */
const LISTEN = `(() => { window.__updates = []; navigator.serviceWorker.addEventListener('message',
  (event) => { if (event.data && event.data.type === 'AppUpdateAvailable') window.__updates.push(event.data.to); });
  return true; })()`;

/** What the x-sw-register.js script does when a hidden tab comes back, then the post it earns. */
const updateWorker = (build: string): string => `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  await registration.update();
  const until = Date.now() + 20000;
  while (!window.__updates.includes(${JSON.stringify(build)}) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.__updates;
})()`;

/**
 * After the click: the island's text once the runtime marks its boot settled — `data-x-mounted` or
 * `data-x-failed` (`@ultimat3/render`'s hydrate runtime) — awaited as the event it is.
 */
const AFTER_CLICK = `new Promise((resolve) => {
  const el = document.querySelector('[data-x-hydrate]');
  const done = () => el.hasAttribute('data-x-mounted') || el.hasAttribute('data-x-failed');
  const answer = () => resolve({ text: el.textContent, failed: el.hasAttribute('data-x-failed') });
  if (done()) return answer();
  new MutationObserver((_, seen) => { if (done()) { seen.disconnect(); answer(); } })
    .observe(el, { attributes: true });
})`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const pods: Bun.Subprocess[] = [];
const browsers: E2eBrowser[] = [];

afterAll(
  async () => {
    for (const pod of pods) pod.kill('SIGTERM');
    for (const browser of browsers) await browser.close();
    await reapIn(BASE);
    await rm(BASE, { recursive: true, force: true });
  },
  3 * E2E_BROWSER_CLOSE_MS + TIMEOUT_MS,
); // a close per `sixDeploys` run, each held open until here

interface Outcome {
  /** `{ text, failed }` of the island once its boot settled. */
  readonly text: unknown;
  readonly islands: readonly { readonly path: string; readonly status: number }[];
  readonly notFound: readonly unknown[];
  readonly updates: unknown;
  readonly first: string;
}

/**
 * One `ROLE=web` process of build `id` on `port` (0: any), booted as a container is. A deploy is the
 * old one gone, then the new one on the SAME port and disk: what the open tab sees as a roll.
 */
async function boot(root: string, id: string, port: string): Promise<string> {
  const previous = pods.at(-1);
  if (previous !== undefined) {
    previous.kill('SIGTERM');
    await previous.exited;
  }
  const { DATABASE_URL: _db, S3_ENDPOINT: _s3, NATS_URL: _nats, ...rest } = Bun.env;
  const child = Bun.spawn([process.execPath, 'apps/web/server.ts'], {
    cwd: root,
    env: { ...rest, NODE_ENV: 'test', ROLE: 'web', PORT: port, METRICS_PORT: '0', BUILD_ID: id },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  pods.push(child);
  const out = pump(child.stdout);
  const err = pump(child.stderr);
  const both = { seen: () => out.seen() + err.seen() };
  const started = await Promise.race([
    waitFor(both, 'ultimate started'),
    child.exited.then(() => `exited: ${both.seen()}`),
  ]);
  const url = /"url":"(?<url>http:[^"]+)"/.exec(started.slice(started.indexOf('ultimate started')))
    ?.groups?.['url'];
  if (url === undefined) return expect.unreachable(`build ${id} did not boot: ${started}`);
  // `localhost`: a service worker needs a secure context, and that is the insecure origin that is one.
  return url.replace('127.0.0.1', 'localhost').replace('0.0.0.0', 'localhost').replace(/\/$/, '');
}

/** Build 0 in a tab, six edited deploys under it, then the click. */
async function sixDeploys(retain: boolean, realtime = false): Promise<Outcome> {
  const root = join(BASE, `${retain ? 'retain' : 'plain'}${realtime ? '-realtime' : ''}`);
  for (const [path, contents] of Object.entries(files(root, retain))) {
    await Bun.write(join(root, path), contents);
  }
  await Bun.write(join(root, 'apps/web/site/counter.island.tsx'), island(0, realtime));
  const base = await boot(root, 'b0', '0');
  const port = new URL(base).port;
  const browser = required ? await openE2eBrowser() : await openE2eBrowserIfAvailable();
  if (browser === undefined)
    return expect.unreachable('a browser was found and then would not open');
  browsers.push(browser);
  const page = e2ePage({ page: browser.page, baseUrl: base });
  await page.goto('/');
  await page.waitForServiceWorker();
  await browser.page.evaluate(LISTEN);
  // From the tab itself: a test process's own fetch is sealed, and the tab is what holds build 0.
  const first = String(
    await browser.page.evaluate(
      `document.querySelector('[data-x-entry]').getAttribute('data-x-entry')`,
    ),
  );
  let build = 0;
  // The harness's own `update()`, handed the deploy the gate's preload hands it: a new BUILD_ID.
  const { update } = e2eFixtures(page, browser.page, async () => {
    await boot(root, `b${build}`, port);
  });
  for (let round = 1; round <= DEPLOYS; round += 1) {
    build = round;
    await Bun.write(join(root, 'apps/web/site/counter.island.tsx'), island(round, realtime));
    await update();
    await browser.page.evaluate(updateWorker(`b${round}`));
  }
  const now = String(
    await browser.page.evaluate(`fetch('/', { cache: 'no-store' }).then((r) => r.text())`),
  );
  // Six edits, six new chunks: a test whose URLs never moved would pass on nothing.
  expect(now).not.toContain(first);
  await page.locator('[data-x-hydrate="interaction"]').click();
  const text = await browser.page.evaluate(AFTER_CLICK);
  const raw = await browser.page.evaluate(REQUEST_LOG);
  const log = (Array.isArray(raw) ? raw : []).map((entry: unknown) => ({
    path: String(Reflect.get(Object(entry), 'path')),
    status: Number(Reflect.get(Object(entry), 'status')),
  }));
  return {
    text,
    islands: log.filter((entry) => entry.path.startsWith('/islands/')),
    notFound: log.filter((entry) => entry.status === 404),
    updates: await browser.page.evaluate('window.__updates'),
    first,
  };
}

describe.skipIf(chrome === undefined && !required)('a tab left open across six deploys', () => {
  test(
    'with assets.retain, the click boots build 0’s island: its chunk 200, no 404, an update offered',
    async () => {
      const outcome = await sixDeploys(true);
      expect(outcome.text).toEqual({ text: 'build 0', failed: false });
      expect(outcome.islands).toEqual([{ path: outcome.first, status: 200 }]);
      expect(outcome.notFound).toEqual([]);
      // Build 0's own worker may post its activation after the listener is on: that one is not news.
      const updates: readonly unknown[] = Array.isArray(outcome.updates) ? outcome.updates : [];
      const news = updates.filter((build) => build !== 'b0');
      expect(news).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    },
    TIMEOUT_MS,
  );

  // The page runtime is a chunk of its own beside the islands (#505): build 0's realtime island
  // imports build 0's copy, so retention has to answer that URL too, not only the island's.
  test(
    'a realtime island: its chunk and build 0’s page runtime both answer 200 after six deploys',
    async () => {
      const outcome = await sixDeploys(true, true);
      expect(outcome.text).toEqual({ text: 'build 0', failed: false });
      const paths = outcome.islands.map((entry) => entry.path);
      expect(paths).toContain(outcome.first);
      expect(paths.some((path) => /^\/islands\/page-runtime\.[0-9a-z]+\.js$/.test(path))).toBe(
        true,
      );
      expect(outcome.islands.filter((entry) => entry.status !== 200)).toEqual([]);
      expect(outcome.notFound).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    'without it, the same click meets a 404 and the island stays dead',
    async () => {
      const outcome = await sixDeploys(false);
      expect(outcome.text).toEqual({ text: 'inert', failed: true });
      expect(outcome.islands).toEqual([{ path: outcome.first, status: 404 }]);
    },
    TIMEOUT_MS,
  );
});
