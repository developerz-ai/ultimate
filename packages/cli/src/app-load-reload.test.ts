// The one registration `loadApp` performs twice: a route module whose SOURCE changed since it
// registered is imported again and its entry replaced, so the page `x dev` serves after a save is
// the page on disk. Every other module keeps the process-wide rule — imported once, its exports
// cached in every importer, a restart to change — which is why the second half of this file pins
// what a save to an action does NOT do, and what a save that will not parse leaves standing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { describeActions } from '@ultimat3/action';
import { clearRoutes, routeFor } from '@ultimat3/render';
import { renderComponent } from '@ultimat3/render/server';
import { loadApp, resetAppLoad } from './app-load';
import { resetRegistries } from './cmd-dev-fixture';

// Under `packages/cli/` for the reason `.dev-fixture` is: the page imports `@ultimat3/render`,
// which resolves through this package's own node_modules and not from /tmp.
const ROOT = join(import.meta.dir, '..', '.app-reload-fixture');
const PAGE = join(ROOT, 'apps/web/app/hello/page.tsx');
const ACTIONS = join(ROOT, 'apps/web/app/hello/actions.ts');

const page = (body: string): string =>
  `import { defineRoute } from '@ultimat3/render';
export const config = defineRoute({ render: 'ssr', hydrate: 'visible', offline: 'runtime', budget: { js: '60kb' }, meta: () => ({ title: 'Hello', description: 'x' }) });
export function Page() { return <p>${body}</p>; }
`;

const actions = (word: string): string =>
  `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
export const greet = action({
  input: t.object({}),
  output: t.object({ word: t.string }),
  policy: allow(),
  async handle() { return { word: '${word}' }; },
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

beforeAll(async () => {
  resetRegistries();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'reload-fixture', version: '1.0.0' }),
  );
  await Bun.write(PAGE, page('one'));
  await Bun.write(ACTIONS, actions('one'));
});

afterAll(async () => {
  try {
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    clearRoutes();
    resetRegistries();
    resetAppLoad();
  }
});

describe('unit · loadApp re-imports a route module whose source changed', () => {
  test('the first scan registers the page as written', async () => {
    expect((await loadApp(ROOT)).findings).toEqual([]);
    expect(await rendered()).toContain('one');
  });

  test('a rescan after a save serves the saved page, and an unchanged one is not re-imported', async () => {
    await Bun.write(PAGE, page('two'));
    const before = routeFor('/hello')?.component;
    expect((await loadApp(ROOT)).findings).toEqual([]);
    expect(await rendered()).toContain('two');
    expect(routeFor('/hello')?.component).not.toBe(before);
    // Same bytes, same module: a rescan for an unrelated save must not mint a page instance per tick.
    const settled = routeFor('/hello')?.component;
    await loadApp(ROOT);
    expect(routeFor('/hello')?.component).toBe(settled);
  });

  test('a save that will not parse is a finding at the file, and the last good page stays up', async () => {
    await Bun.write(PAGE, 'export const config = defineRoute({');
    const loaded = await loadApp(ROOT);
    expect(loaded.findings.map((finding) => finding.at)).toEqual(['apps/web/app/hello/page.tsx']);
    expect(await rendered()).toContain('two');
    // Not sticky, unlike a registration failure: the next save is tried again.
    await Bun.write(PAGE, page('three'));
    expect((await loadApp(ROOT)).findings).toEqual([]);
    expect(await rendered()).toContain('three');
  });

  test('an action module is still registered once — its exports live in every importer', async () => {
    await Bun.write(ACTIONS, actions('two'));
    expect((await loadApp(ROOT)).findings).toEqual([]);
    const greet = describeActions().find((described) => described.name === 'greet');
    expect(greet).toBeDefined();
    // One registration, one name: a re-import here would be `X_ACTION_DUPLICATE`, or a second
    // handler nobody routes to. The restart rule for everything but a route module is unchanged.
    expect(describeActions().filter((described) => described.name === 'greet')).toHaveLength(1);
  });

  // The save that lands DURING the import, made deterministic: the module rewrites its own file
  // while it evaluates, which is what a save between the import and a later read of the file
  // looks like. The entry is bound to the bytes the module was evaluated from — read before the
  // import — so the next scan sees the rewrite and serves it. Bound to a read after the import,
  // the hash was the rewrite's and the component was not, the scan compared equal, and the page
  // on disk was not served until the save after it.
  test('a save that lands during the import is served on the next scan, not the one after', async () => {
    const rewrite = `await Bun.write(import.meta.path, ${JSON.stringify(page('fresh'))});\n`;
    await Bun.write(PAGE, page('stale') + rewrite);
    expect((await loadApp(ROOT)).findings).toEqual([]);
    // This scan evaluated the module that says `stale`, and that is the page it registered.
    expect(await rendered()).toContain('stale');
    expect(await Bun.file(PAGE).text()).toBe(page('fresh'));
    expect((await loadApp(ROOT)).findings).toEqual([]);
    expect(await rendered()).toContain('fresh');
  });
});
