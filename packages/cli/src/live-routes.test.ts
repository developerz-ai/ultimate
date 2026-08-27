// A route that subscribes to live rows and boots no module to receive them. The 500 half of #271
// is `@ultimat3/realtime`'s (a server render now gets its own client and renders `loading`); this
// is the other half — the page that renders `loading` FOREVER, with `x verify` green.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no path joiner and no recursive remove — the rule `cmd-db.test.ts` records.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, island, registerRoute, routeEntries } from '@ultimat3/render';
import { LIVE_HOOKS, liveHooksIn, liveRouteFindings, liveRouteGaps } from './live-routes';

const ROOT = join(import.meta.dir, '..', '.live-routes-fixture');
const PAGE = 'apps/web/app/feed/page.tsx';

const write = (file: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, file), source);

const streamRoute = () =>
  defineRoute({
    render: 'stream',
    hydrate: 'idle',
    offline: 'runtime',
    budget: { js: '60kb' },
    meta: () => ({ title: 'Feed', description: 'the org feed' }),
  });

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});
afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

describe('which imports count as reading live rows', () => {
  test('every hook that needs a client, and nothing else', () => {
    expect(liveHooksIn("import { useLive } from '@ultimat3/realtime';")).toEqual(['useLive']);
    expect(liveHooksIn("import { liveHookFor, useConnection } from '@ultimat3/realtime';")).toEqual(
      ['liveHookFor', 'useConnection'],
    );
    // Not a hook: importing the client class is what an island's mount() legitimately does.
    expect(liveHooksIn("import { LiveClient } from '@ultimat3/realtime';")).toEqual([]);
    // A type is erased before a browser ever sees it, so it boots nothing and needs nothing.
    expect(liveHooksIn("import type { LiveHandle } from '@ultimat3/realtime';")).toEqual([]);
    expect(liveHooksIn("import { type LiveHandle } from '@ultimat3/realtime';")).toEqual([]);
    // Another package's `useLive` is another package's problem.
    expect(liveHooksIn("import { useLive } from '@postly/ui';")).toEqual([]);
  });

  test('a module that asks whether there IS a client has handled its absence', () => {
    const guarded =
      "import { hasLiveClient, useConnection } from '@ultimat3/realtime';\n" +
      'export const Banner = () => (hasLiveClient() ? useConnection() : null);';
    expect(liveHooksIn(guarded)).toEqual([]);
  });

  test('the hook list is the one the error names', () => {
    expect([...LIVE_HOOKS]).toContain('useLive');
    expect([...LIVE_HOOKS]).toContain('useMutationQueue');
  });
});

describe('a route that can never receive a row', () => {
  test('is refused when the hook is in the page itself', async () => {
    await write(PAGE, "import { useConnection } from '@ultimat3/realtime';\nexport const x = 1;");
    registerRoute({ file: PAGE, config: streamRoute(), suspenseBoundaries: 1 });

    const gaps = await liveRouteGaps(ROOT, routeEntries());
    expect(gaps.map((gap) => gap.route)).toEqual(['/feed']);
    expect(gaps[0]?.hook).toBe('useConnection');
    expect(gaps[0]?.at).toBe(PAGE);

    const findings = await liveRouteFindings(ROOT);
    expect(findings[0]?.code).toBe('X_LIVE_ROUTE_NO_ISLAND');
    expect(findings[0]?.fix).toContain('x g island feed --at apps/web/app/feed');
  });

  test('is refused when the hook is a module the page imports', async () => {
    // `examples/dummy`'s exact shape: the page imports its own hook module, which is where
    // `liveHookFor` is called — one hop, and the reason this walks the graph at all.
    await write(PAGE, "import { useLiveFeed } from './hooks';\nexport const x = useLiveFeed;");
    await write(
      'apps/web/app/feed/hooks.ts',
      "import { liveHookFor } from '@ultimat3/realtime';\nexport const useLiveFeed = liveHookFor;",
    );
    registerRoute({ file: PAGE, config: streamRoute(), suspenseBoundaries: 1 });

    const gaps = await liveRouteGaps(ROOT, routeEntries());
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.at).toBe('apps/web/app/feed/hooks.ts');
    expect(gaps[0]?.hook).toBe('liveHookFor');
  });

  test('is refused when it declares an island and never boots it', async () => {
    await write(PAGE, "import { useLive } from '@ultimat3/realtime';\nexport const x = useLive;");
    island({ src: './feed.island.tsx' });
    registerRoute({
      file: PAGE,
      suspenseBoundaries: 1,
      config: defineRoute({
        render: 'stream',
        // Declared and never woken. `X_ISLAND_NOT_HYDRATED` catches this only at RENDER, and only
        // if the island is actually rendered — so a route can hold the contradiction unrendered.
        hydrate: 'never',
        offline: 'runtime',
        meta: () => ({ title: 'Feed', description: 'the org feed' }),
      }),
    });
    expect((await liveRouteGaps(ROOT, routeEntries())).map((gap) => gap.route)).toEqual(['/feed']);
  });
});

describe('a route that can', () => {
  test('declares an island that boots', async () => {
    await write(PAGE, "import { useLive } from '@ultimat3/realtime';\nexport const x = useLive;");
    island({ src: './feed.island.tsx' });
    registerRoute({
      file: PAGE,
      suspenseBoundaries: 1,
      config: defineRoute({
        render: 'stream',
        hydrate: 'idle',
        offline: 'runtime',
        budget: { js: '60kb' },
        meta: () => ({ title: 'Feed', description: 'the org feed' }),
      }),
    });
    expect(await liveRouteGaps(ROOT, routeEntries())).toEqual([]);
  });

  test('reads no live hook at all, however many modules it imports', async () => {
    await write(PAGE, "import { Layout } from '../layout';\nexport const x = Layout;");
    await write('apps/web/app/layout.tsx', "export const Layout = () => 'x';");
    registerRoute({ file: PAGE, config: streamRoute(), suspenseBoundaries: 1 });
    expect(await liveRouteGaps(ROOT, routeEntries())).toEqual([]);
  });

  test('reaches a guarded reader — a banner every page imports is not every page reading live', async () => {
    await write(PAGE, "import { Banner } from '../update-banner';\nexport const x = Banner;");
    await write(
      'apps/web/app/update-banner.tsx',
      "import { hasLiveClient, useConnection } from '@ultimat3/realtime';\n" +
        'export const Banner = () => (hasLiveClient() ? useConnection() : null);',
    );
    registerRoute({ file: PAGE, config: streamRoute(), suspenseBoundaries: 1 });
    expect(await liveRouteGaps(ROOT, routeEntries())).toEqual([]);
  });

  test('a cycle between two of its modules terminates', async () => {
    await write(PAGE, "import { a } from './a';\nexport const x = a;");
    await write('apps/web/app/feed/a.ts', "import { b } from './b';\nexport const a = b;");
    await write('apps/web/app/feed/b.ts', "import { a } from './a';\nexport const b = a;");
    registerRoute({ file: PAGE, config: streamRoute(), suspenseBoundaries: 1 });
    expect(await liveRouteGaps(ROOT, routeEntries())).toEqual([]);
  });
});
