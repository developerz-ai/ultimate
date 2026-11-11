// Exercises two web builds serving each other's retained assets from one shared deployment disk.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { allowHost, paced } from '@ultimat3/testing';
import { pump, reapIn, waitFor } from '../src/dev-live-fixture';
import { processRoot } from '../src/process-root-fixture';

const TIMEOUT_MS = paced(180_000);
const BASE = processRoot(join(import.meta.dir, '..', '.retained-assets-e2e-fixture'));
const DISK = join(BASE, 'shared-disk');

const app = (build: 'one' | 'two'): Readonly<Record<string, string>> => ({
  'package.json': JSON.stringify({ name: `retained-${build}`, version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({
  name: 'retained',
  assets: { retain: { disk: 'deploys', builds: 3 } },
});
`,
  // The shared volume every web pod mounts: the app's own disk, named in \`assets.retain\`.
  'apps/web/shared/storage.ts': `import { defineStorage, localDriver } from '@ultimat3/storage';
export const storage = defineStorage({ disks: { deploys: localDriver({ root: ${JSON.stringify(DISK)} }) } });
`,
  'apps/web/site/page.module.scss': `.build-${build} { color: ${build === 'one' ? 'red' : 'blue'}; }\n`,
  'apps/web/site/counter.island.tsx': `export function mount(el: HTMLElement): void { el.textContent = 'build ${build}'; }\n`,
  'apps/web/site/page.tsx': `import { defineRoute, island } from '@ultimat3/render';
import '../shared/storage';
import './page.module.scss';

const Counter = island({ src: './counter.island.tsx' });

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'interaction',
  offline: 'network-only',
  budget: { js: '20kb' },
  meta: () => ({ title: 'Build ${build}', description: 'one build of a rollout' }),
});

export function Page() {
  return <main><Counter>inert</Counter></main>;
}
`,
  'apps/web/server.ts': `import { join } from 'node:path';
import { runRole } from '@ultimat3/cli/serve';

if (import.meta.main) await runRole({ root: join(import.meta.dir, '..', '..'), env: Bun.env });
`,
});

interface Pod {
  readonly url: string;
  readonly kill: () => void;
}

const pods: Pod[] = [];

/** One `ROLE=web` process, its own state directory and database, booted as a container would be. */
async function boot(build: 'one' | 'two'): Promise<Pod> {
  const root = join(BASE, build);
  for (const [path, contents] of Object.entries(app(build))) {
    await Bun.write(join(root, path), contents);
  }
  const { DATABASE_URL: _db, S3_ENDPOINT: _s3, NATS_URL: _nats, ...rest } = Bun.env;
  const child = Bun.spawn([process.execPath, 'apps/web/server.ts'], {
    cwd: root,
    env: {
      ...rest,
      NODE_ENV: 'test',
      ROLE: 'web',
      PORT: '0',
      METRICS_PORT: '0',
      BUILD_ID: `build-${build}`,
      ULTIMATE_STATE_DIR: join(root, '.x'),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = pump(child.stdout);
  const err = pump(child.stderr);
  const both = { seen: () => out.seen() + err.seen() };
  const started = await Promise.race([
    waitFor(both, 'ultimate started'),
    child.exited.then(() => `exited: ${both.seen()}`),
  ]);
  const url = /"url":"(?<url>http:[^"]+)"/.exec(started.slice(started.indexOf('ultimate started')))
    ?.groups?.['url'];
  if (url === undefined) return expect.unreachable(`the ${build} pod did not boot: ${started}`);
  // The listener binds every interface; the test dials loopback, and lets exactly that through.
  const port = new URL(url).port;
  allowHost(`127.0.0.1:${port}`);
  const pod = { url: `http://127.0.0.1:${port}`, kill: () => child.kill('SIGTERM') };
  pods.push(pod);
  return pod;
}

/** The stylesheet and island chunk a pod's own document names. */
async function assetsOf(pod: Pod): Promise<readonly string[]> {
  const html = await (await fetch(new URL('/', pod.url))).text();
  const style = /<link rel="stylesheet" href="(?<url>\/styles\/[^"]+)">/.exec(html)?.groups?.[
    'url'
  ];
  const chunk = /data-x-entry="(?<url>\/islands\/[^"]+)"/.exec(html)?.groups?.['url'];
  if (style === undefined || chunk === undefined) {
    return expect.unreachable(`the document names no stylesheet or no island: ${html}`);
  }
  return [style, chunk];
}

beforeAll(async () => {
  await rm(BASE, { recursive: true, force: true });
}, TIMEOUT_MS);

afterAll(async () => {
  for (const pod of pods) pod.kill();
  await reapIn(BASE);
  await rm(BASE, { recursive: true, force: true });
}, TIMEOUT_MS);

test(
  'two builds over one retained disk: either pod answers both builds’ /styles and /islands URLs',
  async () => {
    const one = await boot('one');
    const two = await boot('two');
    const ownOne = await assetsOf(one);
    const ownTwo = await assetsOf(two);
    // Two builds: different bytes, so different URLs — otherwise this proves nothing.
    expect(ownOne.filter((url) => ownTwo.includes(url))).toEqual([]);

    for (const [pod, urls] of [
      [one, ownTwo],
      [two, ownOne],
    ] as const) {
      for (const path of urls) {
        const response = await fetch(new URL(path, pod.url));
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      }
    }
    const css = await (await fetch(new URL(ownOne[0] ?? '', two.url))).text();
    expect(css).toContain('red');
  },
  TIMEOUT_MS,
);
