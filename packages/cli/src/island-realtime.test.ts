// Realtime installed for the author, on the islands that use it and on no other. Real builds of a
// fixture app, evaluated in this process: a hook in a wrapped island finds its signal factory and
// the page runtime installed, and the runtime — the store, the socket — ships ONCE per page, in a
// chunk beside the islands, never inside one (#505).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { islandRealtimePlugin, reachesRealtime } from './island-realtime';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'realtime'));

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

/** Reads one record and hands the accessor back, so a case can read what the island renders. */
const READER = `import { useRecord } from '@ultimat3/realtime';
export function mount(): unknown {
  return useRecord('posts', 'p1');
}
`;

/** A string only realtime's `record-store.ts` holds: in a file exactly when the store's code is. */
const STORE_CODE = 'it arrived under an empty key';

/** Every file of the bundle, written where a browser would find it: flat, under one directory. */
async function serve(bundle: IslandBundle, out: string): Promise<void> {
  for (const asset of [...bundle.chunks, ...bundle.shared]) {
    await Bun.write(join(out, asset.url.slice(1)), asset.code);
  }
}

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
    const bundle = await buildIslands(ROOT);
    const [chunk] = bundle.chunks;
    await serve(bundle, join(ROOT, 'out'));
    const island = (await import(join(ROOT, 'out', chunk?.url.slice(1) ?? ''))) as {
      mount: () => string;
    };

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
    const runtime = {
      realtime: '/a/realtime/src/index.ts',
      wait: '/a/realtime/src/page-runtime-wait.ts',
      url: '/islands/page-runtime.abc123.js',
      code: '',
      bytes: 0,
      sources: [],
    };
    islandRealtimePlugin(ROOT, runtime).setup(build as never);
    const install = loads[0]?.({ path: 'install' }).contents ?? '';
    expect(install).toContain("from '@ultimat3/realtime'");
    expect(install).not.toContain(import.meta.dir.split('/packages/')[0] ?? '/');
    expect(install).not.toContain(runtime.wait);
    // The runtime by its own name, relative: beside the island under `/islands/` and in a test.
    expect(install).toContain("import('./page-runtime.abc123.js')");
  });
});

describe('the page runtime, once per page', () => {
  test('an island chunk excludes the store; the one runtime chunk beside it carries it', async () => {
    await write('apps/web/app/reader.island.tsx', READER);
    await write('apps/web/app/live.island.tsx', LIVE);
    const bundle = await buildIslands(ROOT);

    expect(bundle.chunks).toHaveLength(2);
    for (const chunk of bundle.chunks) expect(chunk.code).not.toContain(STORE_CODE);
    const runtimes = bundle.shared.filter((asset) => asset.code.includes(STORE_CODE));
    expect(runtimes).toHaveLength(1);
    const runtime = runtimes[0];
    // Every island that reaches realtime names it, so a precache and a budget both count it.
    for (const chunk of bundle.chunks) expect(chunk.imports).toContain(runtime?.url ?? '');
    expect(runtime?.importers).toEqual(bundle.chunks.map((chunk) => chunk.file).sort());
    expect(bundle.assetAt(runtime?.url ?? '')).toBe(runtime);
  });

  test('two islands on one page share ONE runtime instance', async () => {
    await write('apps/web/app/first.island.tsx', READER);
    await write('apps/web/app/second.island.tsx', READER);
    const bundle = await buildIslands(ROOT);
    const out = join(ROOT, 'out');
    await serve(bundle, out);
    Object.assign(globalThis, { document: {}, window: {} });

    type Reader = { mount: () => () => { status: string; data?: unknown } };
    const [first, second] = (await Promise.all(
      bundle.chunks.map((chunk) => import(join(out, chunk.url.slice(1)))),
    )) as Reader[];
    const a = first?.mount();
    const b = second?.mount();
    const page = Reflect.get(globalThis, Symbol.for('ultimate.realtime')) as {
      store: { adopt(type: string, rows: object): void };
    };
    page.store.adopt('posts', { p1: { id: 'p1', likes: 3 } });

    const left = a?.();
    expect(left).toEqual({ status: 'ready', data: { id: 'p1', likes: 3 } });
    // The same OBJECT through two island bundles: one store, because one runtime installed it.
    expect(left?.data).toBe(b?.().data);
    // ...and one runtime in the bytes too: both name one file, the only one holding the store.
    expect(new Set(bundle.chunks.flatMap((chunk) => chunk.imports)).size).toBe(1);
    const holding = [...bundle.chunks, ...bundle.shared].filter((asset) =>
      asset.code.includes(STORE_CODE),
    );
    expect(holding.map((asset) => asset.url)).toEqual([...(bundle.chunks[0]?.imports ?? [])]);
  });
});
