// The loopback scope against a loopback npm: what `serveScope` answers in each mode — the cut
// packument, HEAD added and its tarball served, the offline cache, a 404 for everything else — and
// `packHead` over a fixture `packages/` of real `bun pm pack` output, restamped and not.

import { afterAll, describe, expect, test } from 'bun:test';
import { allowHost } from '../packages/testing/src/sealed-network';
import { tempTree } from '../packages/testing/src/temp-tree';
import { run } from './lib/run';
import type { PackedPackage } from './upgrade-fixtures-packument';
import { packHead, serveScope } from './upgrade-fixtures-registry';

const CORE = {
  name: '@ultimat3/core',
  'dist-tags': { latest: '2.0.0' },
  versions: {
    '1.0.0': { version: '1.0.0' },
    '1.1.0': { version: '1.1.0' },
    '2.0.0': { version: '2.0.0' },
  },
  time: { '1.0.0': '2026-01-01' },
};

/** npm, as far as these tests need it: one packument, and a 404 for every other name. */
const npm = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === '/@ultimat3%2fcore'
      ? Response.json(CORE)
      : new Response(null, { status: 404 }),
});
const NPM = npm.url.origin;
afterAll(() => npm.stop(true));

/** Both loopback servers through the test seal: the scope server's own fetch to "npm" included. */
const allowLoopback = (url: string): void => {
  allowHost(new URL(url).host);
  allowHost(new URL(NPM).host);
};

const get = async (url: string): Promise<{ status: number; body: unknown }> => {
  allowLoopback(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
};

describe('serveScope · as-of', () => {
  test('the packument is cut back to the release, and `time` is dropped', async () => {
    await using tree = tempTree('upgrade-registry-');
    const scope = serveScope({ kind: 'as-of', version: '1.1.0' }, `${tree.path}/cache`, NPM);
    try {
      const { status, body } = await get(`${scope.url}@ultimat3%2fcore`);
      expect(status).toBe(200);
      expect(body).toEqual({
        name: '@ultimat3/core',
        'dist-tags': { latest: '1.1.0' },
        versions: { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' } },
      });
      // Refreshed into the cache, for the offline run below.
      expect(await Bun.file(`${tree.path}/cache/%40ultimat3%2Fcore.json`).exists()).toBe(true);
    } finally {
      scope.stop();
    }
  });

  test('another prefix, a name outside the scope, a name npm never served: all 404', async () => {
    await using tree = tempTree('upgrade-registry-');
    const scope = serveScope({ kind: 'as-of', version: '1.1.0' }, `${tree.path}/cache`, NPM);
    try {
      // As long as the real prefix, never hex: a stranger's path that only a prefix check refuses.
      const origin = new URL(scope.url).origin;
      expect((await get(`${origin}/zzzzzzzz/@ultimat3%2fcore`)).status).toBe(404);
      expect((await get(`${scope.url}left-pad`)).status).toBe(404);
      expect((await get(`${scope.url}@ultimat3%2fnever`)).status).toBe(404);
      expect((await get(`${scope.url}-/tarball/ultimat3-core-9.9.9.tgz`)).status).toBe(404);
    } finally {
      scope.stop();
    }
  });

  test('an npm that cannot answer is served from the cached packument', async () => {
    await using tree = tempTree('upgrade-registry-');
    const cache = `${tree.path}/cache`;
    await Bun.write(`${cache}/%40ultimat3%2Fcore.json`, JSON.stringify(CORE));
    // npm down: a 503 is neither a packument nor a 404, so the cache is what answers.
    const down = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    allowHost(new URL(down.url.origin).host);
    const scope = serveScope({ kind: 'as-of', version: '1.0.0' }, cache, down.url.origin);
    try {
      const { status, body } = await get(`${scope.url}@ultimat3/core`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ 'dist-tags': { latest: '1.0.0' } });
    } finally {
      scope.stop();
      await down.stop(true);
    }
  });
});

describe('serveScope · head', () => {
  test('HEAD is added as latest with a loopback tarball, which is served byte for byte', async () => {
    await using tree = tempTree('upgrade-registry-');
    const file = `${tree.path}/ultimat3-core-2.1.0.tgz`;
    await Bun.write(file, 'not really a tarball');
    const head: PackedPackage = {
      name: '@ultimat3/core',
      version: '2.1.0',
      manifest: { name: '@ultimat3/core', version: '2.1.0', main: 'index.ts' },
      file,
      integrity: 'sha512-x',
    };
    const scope = serveScope({ kind: 'head', packed: [head] }, `${tree.path}/cache`, NPM);
    try {
      const { body } = await get(`${scope.url}@ultimat3%2fcore`);
      const packument = body as {
        'dist-tags': { latest: string };
        versions: Record<string, { dist?: { tarball: string; integrity: string } }>;
      };
      expect(packument['dist-tags'].latest).toBe('2.1.0');
      expect(Object.keys(packument.versions)).toEqual(['1.0.0', '1.1.0', '2.0.0', '2.1.0']);
      const dist = packument.versions['2.1.0']?.dist;
      expect(dist).toEqual({
        tarball: `${scope.url}-/tarball/ultimat3-core-2.1.0.tgz`,
        integrity: 'sha512-x',
      });
      const tarball = await fetch(dist?.tarball ?? '', { signal: AbortSignal.timeout(10_000) });
      expect(await tarball.text()).toBe('not really a tarball');
      // A scope package HEAD did not pack is npm's, untouched; one npm never served is a 404.
      expect((await get(`${scope.url}@ultimat3%2fnever`)).status).toBe(404);
    } finally {
      scope.stop();
    }
  });

  test('a scope package HEAD did not pack is npm’s own packument, whole', async () => {
    await using tree = tempTree('upgrade-registry-');
    const scope = serveScope({ kind: 'head', packed: [] }, `${tree.path}/cache`, NPM);
    try {
      expect((await get(`${scope.url}@ultimat3%2fcore`)).body).toEqual(CORE);
    } finally {
      scope.stop();
    }
  });
});

const workspace = async (root: string, dir: string, manifest: Record<string, unknown>) => {
  await Bun.write(`${root}/packages/${dir}/package.json`, JSON.stringify(manifest));
  await Bun.write(`${root}/packages/${dir}/index.ts`, 'export const one = 1;\n');
};

const packedManifest = async (file: string): Promise<unknown> => {
  const out = await run(['tar', '-xzOf', file, 'package/package.json'], { cwd: '/' });
  return JSON.parse(out.output);
};

describe('packHead', () => {
  test('only public scope workspaces are packed, restamped to the target with their pins', async () => {
    await using tree = tempTree('upgrade-pack-');
    const root = tree.path;
    await workspace(root, 'core', { name: '@ultimat3/core', version: '2.0.0' });
    await workspace(root, 'jobs', {
      name: '@ultimat3/jobs',
      version: '2.0.0',
      dependencies: { '@ultimat3/core': '2.0.0' },
    });
    await workspace(root, 'secret', { name: '@ultimat3/secret', version: '2.0.0', private: true });
    await workspace(root, 'outside', { name: 'left-pad', version: '2.0.0' });
    await Bun.write(`${root}/packages/empty/README.md`, 'no manifest here\n');
    const { packed, findings } = await packHead(root, `${root}/out`, '2.1.0');
    expect(findings).toEqual([]);
    expect(packed.map((one) => [one.name, one.version])).toEqual([
      ['@ultimat3/core', '2.1.0'],
      ['@ultimat3/jobs', '2.1.0'],
    ]);
    const jobs = packed[1];
    expect(jobs?.file).toEndWith('/out/ultimat3-jobs-2.1.0.tgz');
    expect(jobs?.integrity).toStartWith('sha512-');
    expect(await packedManifest(jobs?.file ?? '')).toMatchObject({
      version: '2.1.0',
      dependencies: { '@ultimat3/core': '2.1.0' },
    });
    // The pack under the old version is replaced, not left beside the restamped one.
    expect(await Bun.file(`${root}/out/ultimat3-jobs-2.0.0.tgz`).exists()).toBe(false);
  });

  test('a target equal to the stamped version keeps the pack as made', async () => {
    await using tree = tempTree('upgrade-pack-');
    await workspace(tree.path, 'core', { name: '@ultimat3/core', version: '2.0.0' });
    const { packed } = await packHead(tree.path, `${tree.path}/out`, '2.0.0');
    expect(packed.map((one) => one.file)).toEqual([`${tree.path}/out/ultimat3-core-2.0.0.tgz`]);
    expect(packed[0]?.manifest).toMatchObject({ name: '@ultimat3/core', version: '2.0.0' });
  });

  test('a workspace bun cannot pack is X_UPGRADE_FIXTURE_UNBUILT, naming its directory', async () => {
    await using tree = tempTree('upgrade-pack-');
    await workspace(tree.path, 'core', {
      name: '@ultimat3/core',
      version: '2.0.0',
      scripts: { prepack: 'exit 3' },
    });
    const { packed, findings } = await packHead(tree.path, `${tree.path}/out`, '2.1.0');
    expect(packed).toEqual([]);
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_UPGRADE_FIXTURE_UNBUILT', 'packages/core/package.json'],
    ]);
  });
});
