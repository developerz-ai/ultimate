// The container boot (`ROLE=web`), end to end: a tag-only ISR page answers its first render, an
// `invalidateTags` lands, and the next request is `x-ultimate-isr: stale` with the regenerated body
// behind it. No boot attached its controller until plan 101 (s2-con #1), so this page served its
// first render for the life of every pod.
//
//   bun test packages/cli/e2e/isr-tag-bust.e2e.test.ts

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { invalidateTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { NotImplementedError, resetLifecycle } from '@ultimat3/core';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from '../src/app-load';
import { serveApp } from '../src/serve';
import type { ServedApp } from '../src/serve-types';

const ROOT = join(import.meta.dir, '..', '.isr-e2e-fixture');
const PROBE = '__xIsrE2eProbe';
const BOOT_TIMEOUT_MS = 120_000;

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'isr-e2e-fixture', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'isr-e2e-fixture' });
`,
  'apps/web/site/journal/page.tsx': `import { tag } from '@ultimat3/cache';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag('post')] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Journal', description: 'A tag-only isr page a bust must reach' }),
});

export function Page() {
  return <main><p>{\`journal \${String(Reflect.get(globalThis, '${PROBE}') ?? 0)}\`}</p></main>;
}
`,
};

let served: ServedApp | undefined;
const restoreTags = isolateDeclaredTags();

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x'), BUILD_ID: 'isr-e2e' };
  const app = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
  if (app.kind === 'served') served = app;
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await served?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    Reflect.deleteProperty(globalThis, PROBE);
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
      fix: 'ROLE=web bun run x -- serve',
    });
  }
  return fetch(new URL(path, url));
}

test(
  'ROLE=web: a tag bust marks a tag-only isr page stale, then serves the regenerated body',
  async () => {
    Reflect.set(globalThis, PROBE, 1);
    const first = await get('/journal');
    expect(await first.text()).toContain('journal 1');

    Reflect.set(globalThis, PROBE, 2);
    await invalidateTags([tag('post')]);
    const stale = await get('/journal');
    expect(stale.headers.get('x-ultimate-isr')).toBe('stale');
    expect(await stale.text()).toContain('journal 1');

    // The regeneration runs behind the stale answer: poll until it lands, never a fixed wait.
    let body = '';
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      body = await (await get('/journal')).text();
      if (body.includes('journal 2')) break;
      await Bun.sleep(25);
    }
    expect(body).toContain('journal 2');
  },
  BOOT_TIMEOUT_MS,
);
