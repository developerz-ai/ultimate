// Realtime installed for the author, on the islands that use it and on no other. Real builds of a
// fixture app, evaluated in this process: a hook in a wrapped island finds its signal factory
// installed; a hook in an island built WITHOUT the wrapper is `X_REALTIME_UNINSTALLED`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import { islandRealtimePlugin, reachesRealtime } from './island-realtime';

const ROOT = join(import.meta.dir, '..', '.island-fixture', 'realtime');

/** Calls a hook at mount and answers the code it threw, or `ok`. */
const LIVE = `import { useConnection } from '@ultimat3/realtime';
export function mount(): string {
  try {
    useConnection();
    return 'ok';
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}
`;
const PLAIN = `export function mount(el: HTMLElement): void { el.textContent = 'plain'; }\n`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'island-realtime-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('reachesRealtime', () => {
  test('a value import one relative hop away counts; a type import and a plain island do not', async () => {
    await write(
      'apps/web/app/a.island.tsx',
      "import { h } from './hooks';\nexport const mount = h;\n",
    );
    await write('apps/web/app/hooks.ts', "export { useQuery as h } from '@ultimat3/realtime';\n");
    await write(
      'apps/web/app/b.island.tsx',
      "import type { QueryRef } from '@ultimat3/realtime';\nexport type X = QueryRef;\n",
    );
    await write('apps/web/app/c.island.tsx', PLAIN);

    expect(await reachesRealtime(ROOT, 'apps/web/app/a.island.tsx')).toBe(true);
    expect(await reachesRealtime(ROOT, 'apps/web/app/c.island.tsx')).toBe(false);
    expect(await reachesRealtime(ROOT, 'apps/web/app/b.island.tsx')).toBe(false);
  });
});

describe('the realtime install the island bundle writes', () => {
  test('a live island installs this bundle signal before its hooks run', async () => {
    await write('apps/web/app/live.island.tsx', LIVE);
    const [chunk] = (await buildIslands(ROOT)).chunks;
    const path = join(ROOT, 'out', 'live.js');
    await Bun.write(path, chunk?.code ?? '');
    const island = (await import(path)) as { mount: () => string };

    // A DOM, so a hook that found nothing installed would throw rather than render the server state.
    Object.assign(globalThis, { document: {}, window: {} });
    expect(island.mount()).not.toBe('X_REALTIME_UNINSTALLED');
  });

  test('a plain island is built from its own file and carries no realtime at all', async () => {
    await write('apps/web/app/plain.island.tsx', PLAIN);
    const [chunk] = (await buildIslands(ROOT)).chunks;
    expect(chunk?.code).not.toContain('ultimate.realtime');
  });

  // The wrapper's source is part of `sourcesContent`, which names the chunk's URL. It spliced in
  // the ABSOLUTE path realtime resolved to, so one island had a different URL in every checkout
  // — and a chunk built on the box that built the image never matched the one it served.
  test('the install source names realtime bare, never a path on this machine', async () => {
    const loads: ((args: { path: string }) => { contents: string })[] = [];
    const build = {
      onResolve: () => undefined,
      onLoad: (_options: unknown, load: (args: { path: string }) => { contents: string }) => {
        loads.push(load);
      },
    };
    islandRealtimePlugin(ROOT, 'apps/web/app/live.island.tsx').setup(build as never);
    const install = loads[0]?.({ path: 'install' }).contents ?? '';
    expect(install).toContain("from '@ultimat3/realtime'");
    expect(install).not.toContain(import.meta.dir.split('/packages/')[0] ?? '/');
  });
});
