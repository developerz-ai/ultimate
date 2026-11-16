// A realtime island builds whatever directory names its install has. Bun's isolated store spells a
// `file:` dependency `node_modules/.bun/@ultimat3+realtime@file+..+..+<dir>/…` — the layout CI's
// scaffold-smoke installs (`scripts/scaffold-smoke-overrides.ts`) — and `Bun.build` refused every
// path the island plugins handed back from there (`island-plugin-path.ts`).

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive copy or delete, temp directory, realpath or symlink API.
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
// why: `node:os` — the temp directory's location; Bun exposes none.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { dirname, join } from 'node:path';
import { buildIslands } from './island-bundle';
import { isRuntimeChunk } from './island-runtime';

const PACKAGES = join(import.meta.dir, '..', '..');
const REPO = join(PACKAGES, '..');

/** The store directory a `file:../../…` install of realtime gets: `+..+` in its name. */
const STORE = 'node_modules/.bun/@ultimat3+realtime@file+..+..+packages+realtime';

/** Calls a hook at mount and answers the code it threw, or `ok` — never uninstalled once installed. */
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

let root = '';

/**
 * An app outside this checkout (inside it, the repo's tsconfig `paths` answer realtime with the
 * workspace's own) whose realtime is a real COPY in a `+..+` store directory — a symlink would
 * realpath back into `packages/`, and that spelling never reached the refusal. Built in the test
 * body, under its timeout: a hook's 5 s default is short for a 4 MB copy on a loaded runner.
 */
async function install(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ultimate-install-path-'));
  await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'install-path' }));
  const copy = join(root, STORE, 'node_modules/@ultimat3/realtime');
  await mkdir(copy, { recursive: true });
  await cp(join(PACKAGES, 'realtime/package.json'), join(copy, 'package.json'));
  await cp(join(PACKAGES, 'realtime/src'), join(copy, 'src'), {
    recursive: true,
    filter: (path) => !path.endsWith('.test.ts'),
  });
  const scope = join(root, 'node_modules/@ultimat3');
  await mkdir(scope, { recursive: true });
  await symlink(copy, join(scope, 'realtime'));
  for (const pkg of ['core', 'entity', 'policy', 'query']) {
    await symlink(join(PACKAGES, pkg), join(scope, pkg));
  }
  await symlink(
    await realpath(join(PACKAGES, 'realtime/node_modules/nats')),
    join(root, 'node_modules/nats'),
  );
  await symlink(
    await realpath(join(REPO, 'node_modules/solid-js')),
    join(root, 'node_modules/solid-js'),
  );
  await mkdir(dirname(join(root, 'apps/web/app/live.island.tsx')), { recursive: true });
  await Bun.write(join(root, 'apps/web/app/live.island.tsx'), LIVE);
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'window');
  if (root === '') return;
  await rm(root, { recursive: true, force: true });
  root = '';
});

describe('a realtime island under a `+..+` install directory', () => {
  test('builds, loads the one runtime chunk, and installs realtime once', async () => {
    await install();
    // The fixture is the case: realtime really resolves into the `+..+` directory.
    expect(await realpath(join(root, 'node_modules/@ultimat3/realtime'))).toContain('+..+');

    const bundle = await buildIslands(root);

    const [island] = bundle.chunks;
    expect(island?.url).toStartWith('/islands/live-');
    expect(bundle.shared.filter((one) => isRuntimeChunk(one.url))).toHaveLength(1);
    expect(island?.imports.filter(isRuntimeChunk)).toHaveLength(1);

    // One realtime module behind both the install and the hooks, or a hook finds no signal.
    for (const asset of [...bundle.chunks, ...bundle.shared]) {
      await Bun.write(join(root, 'out', asset.url.slice(1)), asset.code);
    }
    Object.assign(globalThis, { document: {}, window: {} });
    const served = (await import(join(root, 'out', island?.url.slice(1) ?? ''))) as {
      mount: () => string;
    };
    expect(served.mount()).not.toBe('X_REALTIME_UNINSTALLED');
    // Two real builds; past bun's 5 s default, `afterEach` deleted the root under a running one.
  }, 60_000);
});
