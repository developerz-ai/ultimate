// A save to a module a PAGE imports — a component, its `.module.scss`, a Sass partial that sheet
// `@use`s, a helper — must reach the page `x dev` serves on the next rescan. Until this file, only
// the route module itself was re-imported (`?x-reload=<hash>`), and its own imports resolved to the
// modules already in Bun's cache: `x dev` logged "reloaded" and kept rendering the old component
// (one adopter, 2026-09-27: the panel's balance card and the home page, until a restart).
//
// The second half pins the other side of the rule: a module that DEFINES a primitive (an entity, an
// action) is never re-evaluated — that would be `X_ENTITY_DUPLICATE`, or a second handler nobody
// routes to — and a save loop does not grow the process (the old instances are collectable).

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive mkdir; the root is a module-level `const`, so sync.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { describeActions } from '@ultimat3/action';
import { routeFor } from '@ultimat3/render';
import { clearStylesheets, renderComponent, stylesFor } from '@ultimat3/render/server';
import { loadApp } from './app-load';
import { enableReloadTracking, takeStalePins } from './app-reload-graph';
import { resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';

// Under `packages/cli/` for the reason `.dev-fixture` is: the page imports `@ultimat3/render`,
// which resolves through this package's own node_modules and not from /tmp. And a directory of
// this LOAD's own below the process's: the fixture's modules stay in Bun's cache for the life of
// the process, so each TEST takes a root of its own: on a shared one, a test read the saves of
// whichever ran before it, and a second load (`--rerun-each`) found the old modules.
const RUN = processRoot(join(import.meta.dir, '..', '.app-graph-fixture'));
mkdirSync(RUN, { recursive: true });

const pathsUnder = (root: string) => {
  const dir = join(root, 'apps/web/app/hello');
  return {
    root,
    page: join(dir, 'page.tsx'),
    card: join(dir, 'card.tsx'),
    sheet: join(dir, 'card.module.scss'),
    partial: join(dir, '_tokens.scss'),
    label: join(dir, 'label.ts'),
    entity: join(dir, 'entity.ts'),
    actions: join(dir, 'actions.ts'),
    client: join(root, 'apps/web/shared/client.ts'),
  };
};

let app = pathsUnder(RUN);

// A typed client whose every property read throws until the env names an origin — the shape of
// examples/dummy's `shared/client.ts`. Asking it "are you a primitive?" must not read it.
const CLIENT_SOURCE = `export const client = new Proxy({}, {
  get() { throw new TypeError('APP_URL is unset'); },
});
`;

const PAGE_SOURCE = `import { defineRoute } from '@ultimat3/render';
import { Card } from './card';
import { notes } from './entity';
export const config = defineRoute({ render: 'ssr', hydrate: 'visible', offline: 'runtime', budget: { js: '60kb' }, meta: () => ({ title: 'Hello', description: 'x' }) });
export const notesKind = typeof notes;
export function Page() { return <main><Card /></main>; }
`;

const card = (word: string): string => `import styles from './card.module.scss';
import { label } from './label';
export function Card() { return <p class={styles.card}>${word} {label}</p>; }
`;

const sheet = (padding: string): string => `@use './tokens';
.card { color: tokens.$ink; padding: ${padding}; }
`;

const partial = (ink: string): string => `$ink: ${ink};\n`;
const label = (text: string): string => `export const label = '${text}';\n`;

const ENTITY_SOURCE = `import { entity, uuid } from '@ultimat3/entity';
import { label } from './label';
export const notes = entity('graph_notes', { columns: { id: uuid().primaryKey() } });
export const noteLabel = label;
`;

const ACTIONS_SOURCE = `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { label } from './label';
export const greetGraph = action({
  input: t.object({}),
  output: t.object({ word: t.string }),
  policy: allow(),
  async handle() { return { word: label }; },
});
`;

const rendered = async (): Promise<string> => {
  const entry = routeFor('/hello');
  if (entry?.component === undefined) return expect.unreachable('/hello registered no component');
  return renderComponent(
    entry.component,
    { data: {}, params: {}, url: 'http://dev.test/hello', query: {} },
    entry.file,
  );
};

const rescan = async (): Promise<void> => {
  expect((await loadApp(app.root)).findings).toEqual([]);
};

// Every test starts from the page as written, already served once.
beforeEach(async () => {
  resetRegistries();
  clearStylesheets();
  enableReloadTracking(true);
  app = pathsUnder(mkdtempSync(join(RUN, 'load-')));
  await Bun.write(join(app.root, 'package.json'), JSON.stringify({ name: 'graph-fixture' }));
  await Bun.write(app.page, PAGE_SOURCE);
  await Bun.write(app.card, card('one'));
  await Bun.write(app.sheet, sheet('1px'));
  await Bun.write(app.partial, partial('#111111'));
  await Bun.write(app.label, label('first'));
  await Bun.write(app.entity, ENTITY_SOURCE);
  await Bun.write(app.actions, ACTIONS_SOURCE);
  await Bun.write(app.client, CLIENT_SOURCE);
  await rescan();
});

afterEach(async () => {
  try {
    await rm(app.root, { recursive: true, force: true });
  } finally {
    enableReloadTracking(false);
    clearStylesheets();
    resetRegistries();
  }
});

afterAll(async () => {
  await rm(RUN, { recursive: true, force: true });
});

describe('unit · a rescan re-evaluates what a page imports, not only the page', () => {
  test('the first scan serves the page as written', async () => {
    const html = await rendered();
    expect(html).toContain('one first');
    expect(stylesFor('app')).toContain('#111');
  });

  test('a save to a component the page imports is served on the next rescan', async () => {
    await Bun.write(app.card, card('two'));
    await rescan();
    expect(await rendered()).toContain('two first');
  });

  test('a save to a helper two imports down reaches the page', async () => {
    await Bun.write(app.label, label('second'));
    await rescan();
    expect(await rendered()).toContain('one second');
  });

  test('a save to the component stylesheet re-scopes it and the page renders the new class', async () => {
    const before = (await rendered()).match(/class="([^"]+)"/)?.[1];
    await Bun.write(app.sheet, sheet('7px'));
    await rescan();
    const after = (await rendered()).match(/class="([^"]+)"/)?.[1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(stylesFor('app')).toContain('padding:7px');
    expect(stylesFor('app')).toContain(`.${after}`);
  });

  test('a save to a Sass partial the sheet @use-s reaches the served CSS', async () => {
    await Bun.write(app.partial, partial('#abcdef'));
    await rescan();
    expect(stylesFor('app')).toContain('#abcdef');
    expect(stylesFor('app')).not.toContain('#111');
  });

  test('a rescan with no save re-imports nothing', async () => {
    const settled = routeFor('/hello')?.component;
    expect(settled).toBeFunction();
    await rescan();
    expect(routeFor('/hello')?.component).toBe(settled);
  });

  test('a module that defines a primitive is never re-evaluated — no duplicate, no finding', async () => {
    // `label.ts` is imported by the entity module and the action module as well as the page: a
    // save to it re-evaluates the page's chain and leaves both definitions registered once.
    takeStalePins();
    await Bun.write(app.label, label('third'));
    await rescan();
    expect(await rendered()).toContain('one third');
    expect(describeActions().filter((a) => a.name === 'greetGraph')).toHaveLength(1);
    // …and the two definitions still hold the OLD `label`: the rescan says so, per pinned module,
    // so `x dev` can restart instead of serving an action that answers the previous word.
    expect(takeStalePins()).toEqual([
      { changed: app.label, pinned: app.actions },
      { changed: app.label, pinned: app.entity },
    ]);
    // Read once: a rescan with no save names nothing.
    await rescan();
    expect(takeStalePins()).toEqual([]);
    // A save to the entity module itself is a restart, as before — never X_ENTITY_DUPLICATE.
    await Bun.write(app.entity, `${ENTITY_SOURCE}// edited\n`);
    await rescan();
    expect(await rendered()).toContain('one third');
    expect(takeStalePins()).toEqual([{ changed: app.entity, pinned: app.entity }]);
  });

  test('a component that will not parse is a finding, the last good page stays, the fix is served', async () => {
    await Bun.write(app.card, 'export function Card( {');
    const loaded = await loadApp(app.root);
    expect(loaded.findings.map((finding) => finding.at)).toContain('apps/web/app/hello/card.tsx');
    expect(await rendered()).toContain('one first');
    await Bun.write(app.card, card('four'));
    await rescan();
    expect(await rendered()).toContain('four first');
  });

  test('fifty saves do not grow the process: the replaced instances are collected', async () => {
    const heavy = (n: number): string => `import styles from './card.module.scss';
import { label } from './label';
const ballast = new Array(1_000_000).fill(${n});
export function Card() { return <p class={styles.card}>n${n} {label} {ballast.length}</p>; }
`;
    // The LIVE JS heap after a full collection, not RSS. The ballast is a JS array, so a retained
    // generation is in `heapUsed` byte for byte (8 MB each), and a collected one leaves it. RSS
    // was the flaky reading: the allocator keeps freed pages mapped, so under load (other suites
    // allocating in parallel, a GC that has not returned pages yet) it rose with nothing retained.
    // Two collections, because the first can leave finalizer-reachable garbage for the second.
    const liveHeap = (): number => {
      Bun.gc(true);
      Bun.gc(true);
      return process.memoryUsage().heapUsed;
    };
    // Warm-up: the first few generations settle JIT and allocator state, and the baseline is
    // taken only after them.
    for (let n = 0; n < 5; n += 1) {
      await Bun.write(app.card, heavy(n));
      await rescan();
    }
    const start = liveHeap();
    for (let n = 5; n < 55; n += 1) {
      await Bun.write(app.card, heavy(n));
      await rescan();
    }
    expect(await rendered()).toContain('n54 first');
    // Each generation holds 8 MB of ballast: fifty retained ones would be 400 MB of live heap. The
    // live heap is steady enough (well under 1 MB of drift here) that the line sits TIGHTER than
    // the old RSS one did — five retained generations cross it, where RSS needed fifteen.
    expect(liveHeap() - start).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);
});
