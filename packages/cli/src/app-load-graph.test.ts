// A save to a module a PAGE imports — a component, its `.module.scss`, a Sass partial that sheet
// `@use`s, a helper — must reach the page `x dev` serves on the next rescan. Until this file, only
// the route module itself was re-imported (`?x-reload=<hash>`), and its own imports resolved to the
// modules already in Bun's cache: `x dev` logged "reloaded" and kept rendering the old component
// (notificado.co, 2026-09-27: the panel's balance card and the home page, until a restart).
//
// The second half pins the other side of the rule: a module that DEFINES a primitive (an entity, an
// action) is never re-evaluated — that would be `X_ENTITY_DUPLICATE`, or a second handler nobody
// routes to — and a save loop does not grow the process (the old instances are collectable).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { describeActions } from '@ultimat3/action';
import { clearRoutes, routeFor } from '@ultimat3/render';
import { clearStylesheets, renderComponent, stylesFor } from '@ultimat3/render/server';
import { loadApp, resetAppLoad } from './app-load';
import { enableReloadTracking, takeStalePins } from './app-reload-graph';
import { resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';

// Under `packages/cli/` for the reason `.dev-fixture` is: the page imports `@ultimat3/render`,
// which resolves through this package's own node_modules and not from /tmp.
const ROOT = processRoot(join(import.meta.dir, '..', '.app-graph-fixture'));
const DIR = join(ROOT, 'apps/web/app/hello');
const PAGE = join(DIR, 'page.tsx');
const CARD = join(DIR, 'card.tsx');
const SHEET = join(DIR, 'card.module.scss');
const PARTIAL = join(DIR, '_tokens.scss');
const LABEL = join(DIR, 'label.ts');
const ENTITY = join(DIR, 'entity.ts');
const ACTIONS = join(DIR, 'actions.ts');
// A typed client whose every property read throws until the env names an origin — the shape of
// examples/dummy's `shared/client.ts`. Asking it "are you a primitive?" must not read it.
const CLIENT = join(ROOT, 'apps/web/shared/client.ts');
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
  expect((await loadApp(ROOT)).findings).toEqual([]);
};

beforeAll(async () => {
  resetRegistries();
  clearStylesheets();
  enableReloadTracking(true);
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'graph-fixture' }));
  await Bun.write(PAGE, PAGE_SOURCE);
  await Bun.write(CARD, card('one'));
  await Bun.write(SHEET, sheet('1px'));
  await Bun.write(PARTIAL, partial('#111111'));
  await Bun.write(LABEL, label('first'));
  await Bun.write(ENTITY, ENTITY_SOURCE);
  await Bun.write(ACTIONS, ACTIONS_SOURCE);
  await Bun.write(CLIENT, CLIENT_SOURCE);
});

afterAll(async () => {
  try {
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    enableReloadTracking(false);
    clearRoutes();
    clearStylesheets();
    resetRegistries();
    resetAppLoad();
  }
});

describe('unit · a rescan re-evaluates what a page imports, not only the page', () => {
  test('the first scan serves the page as written', async () => {
    await rescan();
    const html = await rendered();
    expect(html).toContain('one first');
    expect(stylesFor('app')).toContain('#111');
  });

  test('a save to a component the page imports is served on the next rescan', async () => {
    await Bun.write(CARD, card('two'));
    await rescan();
    expect(await rendered()).toContain('two first');
  });

  test('a save to a helper two imports down reaches the page', async () => {
    await Bun.write(LABEL, label('second'));
    await rescan();
    expect(await rendered()).toContain('two second');
  });

  test('a save to the component stylesheet re-scopes it and the page renders the new class', async () => {
    const before = (await rendered()).match(/class="([^"]+)"/)?.[1];
    await Bun.write(SHEET, sheet('7px'));
    await rescan();
    const after = (await rendered()).match(/class="([^"]+)"/)?.[1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(stylesFor('app')).toContain('padding:7px');
    expect(stylesFor('app')).toContain(`.${after}`);
  });

  test('a save to a Sass partial the sheet @use-s reaches the served CSS', async () => {
    await Bun.write(PARTIAL, partial('#abcdef'));
    await rescan();
    expect(stylesFor('app')).toContain('#abcdef');
    expect(stylesFor('app')).not.toContain('#111');
  });

  test('a rescan with no save re-imports nothing', async () => {
    const settled = routeFor('/hello')?.component;
    await rescan();
    expect(routeFor('/hello')?.component).toBe(settled);
  });

  test('a module that defines a primitive is never re-evaluated — no duplicate, no finding', async () => {
    // `label.ts` is imported by the entity module and the action module as well as the page: a
    // save to it re-evaluates the page's chain and leaves both definitions registered once.
    takeStalePins();
    await Bun.write(LABEL, label('third'));
    await rescan();
    expect(await rendered()).toContain('two third');
    expect(describeActions().filter((a) => a.name === 'greetGraph')).toHaveLength(1);
    // …and the two definitions still hold the OLD `label`: the rescan says so, per pinned module,
    // so `x dev` can restart instead of serving an action that answers the previous word.
    expect(takeStalePins()).toEqual([
      { changed: LABEL, pinned: ACTIONS },
      { changed: LABEL, pinned: ENTITY },
    ]);
    // Read once: a rescan with no save names nothing.
    await rescan();
    expect(takeStalePins()).toEqual([]);
    // A save to the entity module itself is a restart, as before — never X_ENTITY_DUPLICATE.
    await Bun.write(ENTITY, `${ENTITY_SOURCE}// edited\n`);
    await rescan();
    expect(await rendered()).toContain('two third');
    expect(takeStalePins()).toEqual([{ changed: ENTITY, pinned: ENTITY }]);
  });

  test('a component that will not parse is a finding, the last good page stays, the fix is served', async () => {
    await Bun.write(CARD, 'export function Card( {');
    const loaded = await loadApp(ROOT);
    expect(loaded.findings.map((finding) => finding.at)).toContain('apps/web/app/hello/card.tsx');
    expect(await rendered()).toContain('two third');
    await Bun.write(CARD, card('four'));
    await rescan();
    expect(await rendered()).toContain('four third');
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
      await Bun.write(CARD, heavy(n));
      await rescan();
    }
    const start = liveHeap();
    for (let n = 5; n < 55; n += 1) {
      await Bun.write(CARD, heavy(n));
      await rescan();
    }
    expect(await rendered()).toContain('n54 third');
    // Each generation holds 8 MB of ballast: fifty retained ones would be 400 MB of live heap. The
    // live heap is steady enough (well under 1 MB of drift here) that the line sits TIGHTER than
    // the old RSS one did — five retained generations cross it, where RSS needed fifteen.
    expect(liveHeap() - start).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);
});
