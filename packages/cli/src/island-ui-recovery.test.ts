// `@ultimat3/ui`'s DataTable in a REAL island: `buildIslands` (Babel's Solid transform plus a
// browser bundle) and `mountIsland`. ui cannot prove this itself — its `.tsx` never compiles to
// Solid under `bun test` — and a component body runs once in an island, so a branch decided there
// kept a table that first failed on its error state after the query recovered.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MountedIsland } from '@ultimat3/testing';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from './island-bundle';
import type { FixtureApp } from './templates/island-fixture';
import { fixtureAppRoot } from './templates/island-fixture';

const FILE = 'apps/web/site/table.island.tsx';

const ISLAND = `import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext } from 'solid-js';
import { render } from 'solid-js/web';
import { DataTable, setSolidRuntime } from '@ultimat3/ui';

interface Row { id: string }

export function mount(el: HTMLElement): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  const [error, setError] = createSignal<unknown>({ code: 'X_TEST', cause: 'the query failed', fix: 'retry' });
  const [rows, setRows] = createSignal<Row[]>([]);
  (globalThis as Record<string, unknown>)['__recover'] = (): void => {
    setError(undefined);
    setRows([{ id: 'r1' }]);
  };
  render(
    () => (
      <DataTable
        caption="Runs"
        columns={[{ key: 'id', header: 'Id', cell: (row: Row) => row.id }]}
        rows={rows()}
        error={error()}
        rowKey={(row: Row) => row.id}
      />
    ),
    el,
  );
}
`;

let app: FixtureApp | undefined;
let mounted: MountedIsland | undefined;

// `fixtureAppRoot` links every workspace into the app's `node_modules`, so the island imports
// `@ultimat3/ui` by specifier and resolves THIS checkout's copy, as a real app would.
beforeAll(async () => {
  app = await fixtureAppRoot('ui-recovery', [{ path: FILE, contents: ISLAND }]);
  mounted = await mountIsland({
    build: (root: string) => buildIslands(root, { only: FILE }),
    root: app.path,
    file: FILE,
    props: {},
  });
}, 60_000);

// `?.`: a `beforeAll` that threw leaves nothing mounted, and the fake `document` must not outlive
// this file either way.
afterAll(() => {
  mounted?.[Symbol.dispose]();
  app?.[Symbol.dispose]();
  Reflect.deleteProperty(globalThis, '__recover');
});

describe('unit · a DataTable in an island follows its state', () => {
  test('it opens on the error state, and leaves it when the query recovers', async () => {
    const island = mounted as MountedIsland;
    expect(island.all('table')).toHaveLength(0);

    const recover = Reflect.get(globalThis, '__recover') as () => void;
    recover();
    // One macrotask: Solid flushes the signal writes before the next one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(island.all('table')).toHaveLength(1);
    expect(island.all('tr[data-row]')).toHaveLength(1);
  });
});
