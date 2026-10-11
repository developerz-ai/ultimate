// The container boot (`ROLE=web`) FROM THE PREBUILT STORE — what `x serve` runs in an image — must
// honour `revalidate.onInvalidate` and `revalidate.query`. The controller reads both from the route
// table the boot loads, never from a build artifact; this pins that, because "works in `x dev`,
// ignored in the prebuilt image" is a failure only a prebuilt boot can show.
//
//   bun test packages/cli/e2e/isr-purge-prebuilt.e2e.test.ts

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { invalidateTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { NotImplementedError, resetLifecycle } from '@ultimat3/core';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from '../src/app-load';
import { prebuildImage } from '../src/image-prepare';
import { processRoot } from '../src/process-root-fixture';
import { serveApp } from '../src/serve';
import { PREBUILT_DIR } from '../src/serve-prebuilt-paths';
import type { ServedApp } from '../src/serve-types';

const ROOT = processRoot(join(import.meta.dir, '..', '.isr-purge-e2e-fixture'));
const PROBE = '__xIsrPurgeE2eProbe';
const BOOT_TIMEOUT_MS = 120_000;

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'isr-purge-e2e-fixture', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'isr-purge-e2e-fixture' });
`,
  'apps/web/site/journal/page.tsx': `import { tag } from '@ultimat3/cache';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag('post')], ttl: '10m', onInvalidate: 'purge', query: ['page'] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: ({ url }) => ({
    title: 'Journal',
    description: 'A purge isr page a withdrawal must take down',
    canonical: url,
  }),
});

export function Page(props: { readonly query: Readonly<Record<string, string>> }) {
  const render = Number(Reflect.get(globalThis, '${PROBE}:renders') ?? 0) + 1;
  Reflect.set(globalThis, '${PROBE}:renders', render);
  const edition = String(Reflect.get(globalThis, '${PROBE}') ?? 0);
  return <main><p>{\`journal \${edition} page \${props.query.page ?? '1'} render \${String(render)}\`}</p></main>;
}
`,
};

let served: ServedApp | undefined;
let prebuilt: Awaited<ReturnType<typeof prebuildImage>> | undefined;
const restoreTags = isolateDeclaredTags();

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  // The image build, then a boot that starts from nothing but what it wrote — as a container does.
  prebuilt = await prebuildImage(ROOT);
  clearRoutes();
  resetAppLoad();
  const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x'), BUILD_ID: 'isr-purge-e2e' };
  const app = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
  if (app.kind === 'served') served = app;
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await served?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    Reflect.deleteProperty(globalThis, PROBE);
    Reflect.deleteProperty(globalThis, `${PROBE}:renders`);
    clearRoutes();
    resetAppLoad();
    restoreTags();
    resetLifecycle();
  }
}, BOOT_TIMEOUT_MS);

async function get(path: string): Promise<Response> {
  const url = served?.url;
  if (url === undefined || url === null) {
    throw new NotImplementedError({
      cause: 'an ISR request against a pod that serves no HTTP is not implemented in this build',
      fix: 'ROLE=web bun apps/web/server.ts',
    });
  }
  return fetch(new URL(path, url));
}

const renderOf = (body: string): string => / render (\d+)/.exec(body)?.[1] ?? '?';

test(
  'ROLE=web from the prebuilt store: the declared query keys the page, and a purge takes it down on the next request',
  async () => {
    expect(prebuilt?.dir).toBe(PREBUILT_DIR);
    expect(prebuilt?.findings).toEqual([]);
    Reflect.set(globalThis, PROBE, 1);

    // `query: ['page']`: a tracking parameter is the same stored page, a declared one is its own.
    const first = await get('/journal');
    const firstBody = await first.text();
    expect(firstBody).toContain('journal 1 page 1');
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=600');
    const tracked = await (await get('/journal?utm_source=mail&x=1')).text();
    expect(renderOf(tracked)).toBe(renderOf(firstBody));
    expect(tracked).toContain(
      `rel="canonical" href="${new URL('/journal', served?.url ?? '').href}`,
    );
    const second = await (await get('/journal?page=2&utm_source=mail')).text();
    expect(second).toContain('journal 1 page 2');
    expect(renderOf(second)).not.toBe(renderOf(firstBody));

    // `onInvalidate: 'purge'`: ONE request, no poll — there is no stale copy to be answered first.
    Reflect.set(globalThis, PROBE, 2);
    await invalidateTags([tag('post')]);
    for (const path of ['/journal', '/journal?page=2', '/journal?utm_source=mail']) {
      const after = await get(path);
      expect({ path, stale: after.headers.get('x-ultimate-isr') }).toEqual({ path, stale: null });
      expect(await after.text()).toContain('journal 2');
    }
  },
  BOOT_TIMEOUT_MS,
);
