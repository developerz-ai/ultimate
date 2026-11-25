// The install an unresolved import's fix prints, run as printed against a local registry: the next load
// passes, whichever directory's install it is that was incomplete.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no symlink API and no recursive remove.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { childLoad } from './app-load-child-fixture';
import { unresolvedImportFinding } from './app-load-unresolved';
import { exec } from './exec';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

let root = '';

const load = (): Promise<readonly Finding[]> => childLoad(root);

/** A one-file npm tarball, by hand: a tar header is 512 bytes of fields and a checksum. */
const packageTarball = async (
  name: string,
  source: string,
  dependencies: Readonly<Record<string, string>> = {},
  files: readonly (readonly [string, string])[] = [],
): Promise<Uint8Array<ArrayBuffer>> => {
  const encoder = new TextEncoder();
  const entry = (path: string, text: string): Uint8Array<ArrayBuffer> => {
    const body = encoder.encode(text);
    const padded = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
    const field = (at: number, value: string) => padded.set(encoder.encode(value), at);
    field(0, path);
    field(100, '0000644');
    field(108, '0000000');
    field(116, '0000000');
    field(124, body.length.toString(8).padStart(11, '0'));
    field(136, '00000000000');
    field(148, '        ');
    field(156, '0');
    field(257, 'ustar');
    field(263, '00');
    const sum = padded.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    field(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    padded.set(body, 512);
    return padded;
  };
  const tar = new Blob([
    entry(
      'package/package.json',
      JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies }),
    ),
    entry('package/index.js', source),
    ...files.map(([path, text]) => entry(`package/${path}`, text)),
    new Uint8Array(1024),
  ]);
  return new Uint8Array(Bun.gzipSync(new Uint8Array(await tar.arrayBuffer())));
};

interface Served {
  readonly tarball: Uint8Array<ArrayBuffer>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** A local npm registry: one version of each package, its metadata and its tarball. */
const registryOf = (packages: Readonly<Record<string, Served>>) =>
  Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname, origin } = new URL(request.url);
      const name = pathname.slice(1).replace(/-1\.0\.0\.tgz$/, '');
      const served = packages[name];
      if (served === undefined) return new Response('no such package', { status: 404 });
      if (pathname.endsWith('.tgz')) return new Response(served.tarball);
      const tarball = `${origin}/${name}-1.0.0.tgz`;
      const dependencies = served.dependencies ?? {};
      const version = { name, version: '1.0.0', dependencies, dist: { tarball } };
      return Response.json({
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': version },
      });
    },
  });

/** The line as a reader pastes it, against that registry. */
const runFix = async (fix: string | undefined, registry: string): Promise<void> => {
  const child = Bun.spawn(['sh', '-c', fix ?? ''], {
    cwd: root,
    env: {
      ...Bun.env,
      BUN_CONFIG_REGISTRY: registry,
      BUN_INSTALL_CACHE_DIR: join(root, '.bun-cache'),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const said = await new Response(child.stderr).text();
  expect({ code: await child.exited, said }).toEqual({ code: 0, said: expect.any(String) });
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-app-load-install-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the printed install', () => {
  // Executed, not read. A local registry, because the line goes to one: `bun add` asks it for the
  // package's metadata and its tarball, and the next load finds it in `node_modules`.
  test('the printed bun add runs, and the next load passes', async () => {
    const dir = join(root, 'apps/web/app/installed');
    await Bun.write(join(dir, 'a.ts'), "export { x } from 'fix-truth-pkg';\n");
    await Bun.write(join(root, 'package.json'), '{ "name": "fixture", "version": "0.0.0" }\n');
    const [finding] = await load();
    expect(finding?.fix).toBe('bun add fix-truth-pkg');
    const tarball = await packageTarball('fix-truth-pkg', 'export const x = 1;\n');
    const registry = registryOf({ 'fix-truth-pkg': { tarball } });
    try {
      await runFix(finding?.fix, registry.url.href);
      expect(await load()).toEqual([]);
    } finally {
      registry.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // A dependency an installed package declares, pruned out of `node_modules`: the app declares
  // nothing new, so the lockfile already names it and the install is what is incomplete.
  test('the printed bun install restores a pruned dependency, and the next load passes', async () => {
    const dir = join(root, 'apps/web/app/pruned');
    await Bun.write(join(dir, 'a.ts'), "export { x } from 'outer-pkg';\n");
    const manifest = { name: 'fixture', version: '0.0.0', dependencies: { 'outer-pkg': '1.0.0' } };
    await Bun.write(join(root, 'package.json'), JSON.stringify(manifest));
    const inner = { 'inner-pkg': '1.0.0' };
    const registry = registryOf({
      'outer-pkg': {
        tarball: await packageTarball('outer-pkg', "export { x } from 'inner-pkg';\n", inner),
        dependencies: inner,
      },
      'inner-pkg': { tarball: await packageTarball('inner-pkg', 'export const x = 1;\n') },
    });
    try {
      await runFix('bun install', registry.url.href);
      expect(await load()).toEqual([]);
      rmSync(join(root, 'node_modules/inner-pkg'), { recursive: true, force: true });
      const [finding] = await load();
      expect(finding?.at).toBe('apps/web/app/pruned/a.ts');
      expect(finding?.fix).toStartWith('bun install --frozen-lockfile   # ');
      await runFix(finding?.fix, registry.url.href);
      expect(await load()).toEqual([]);
      const kept = (await Bun.file(join(root, 'package.json')).json()) as typeof manifest;
      expect(kept.dependencies).toEqual({ 'outer-pkg': '1.0.0' });
    } finally {
      registry.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // An installed package with a file of its own gone: no line of the app's is wrong.
  test('the printed bun install --force restores a damaged package, and the next load passes', async () => {
    const dir = join(root, 'apps/web/app/damaged');
    await Bun.write(join(dir, 'a.ts'), "export { x } from 'hurt-pkg';\n");
    const manifest = { name: 'fixture', version: '0.0.0', dependencies: { 'hurt-pkg': '1.0.0' } };
    await Bun.write(join(root, 'package.json'), JSON.stringify(manifest));
    const tarball = await packageTarball('hurt-pkg', "export { x } from './part.js';\n", {}, [
      ['part.js', 'export const x = 1;\n'],
    ]);
    const registry = registryOf({ 'hurt-pkg': { tarball } });
    try {
      await runFix('bun install', registry.url.href);
      expect(await load()).toEqual([]);
      const part = join(root, 'node_modules/hurt-pkg/part.js');
      rmSync(part);
      const [finding] = await load();
      expect([finding?.at, finding?.cause]).toEqual([
        'apps/web/app/damaged/a.ts',
        'apps/web/app/damaged/a.ts imports "hurt-pkg", and that reaches "./part.js", which resolves to no file: apps/web/app/damaged/a.ts → hurt-pkg/index.js → ./part.js',
      ]);
      expect(finding?.fix).toStartWith('bun install --force   # ');
      await runFix(finding?.fix, registry.url.href);
      expect(await Bun.file(part).exists()).toBe(true);
      expect(await load()).toEqual([]);
    } finally {
      registry.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // A linked checkout is source its owner edits: no install of the app's writes a byte of it.
  test('a linked package: the broken import in its checkout, and its own install', async () => {
    const dir = join(root, 'apps/web/app/linked');
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'x-linked-checkout-')));
    const manifest = { name: 'linked-pkg', version: '1.0.0', main: 'index.js' };
    await Bun.write(join(checkout, 'package.json'), JSON.stringify(manifest));
    await Bun.write(join(checkout, 'index.js'), "export { x } from './gone.js';\n");
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(checkout, join(root, 'node_modules/linked-pkg'));
    await Bun.write(join(dir, 'a.ts'), "export { x } from 'linked-pkg';\n");
    const inner = { 'inner-pkg': '1.0.0' };
    const registry = registryOf({
      'inner-pkg': { tarball: await packageTarball('inner-pkg', 'export const x = 1;\n') },
    });
    try {
      const [broken] = await load();
      expect(broken?.at).toBe('apps/web/app/linked/a.ts');
      expect(broken?.fix).toStartWith('grep -nF -- ./gone.js ');
      const shown = await exec(['sh', '-c', broken?.fix ?? ''], { cwd: root });
      expect([shown.code, shown.stdout]).toEqual([0, "1:export { x } from './gone.js';\n"]);
      // A subpath an installed package lacks is the same edit, in the same file.
      await Bun.write(join(checkout, 'node_modules/has-pkg/package.json'), '{"name":"has-pkg"}');
      await Bun.write(join(checkout, 'index.js'), "export { x } from 'has-pkg/nope';\n");
      expect((await load())[0]?.fix).toStartWith('grep -nF -- has-pkg/nope ');
      // A dependency it declares is installed there: one in the app would not resolve from here.
      await Bun.write(join(checkout, 'index.js'), "export { x } from 'inner-pkg';\n");
      await Bun.write(
        join(checkout, 'package.json'),
        JSON.stringify({ ...manifest, dependencies: inner }),
      );
      const [owed] = await load();
      expect(owed?.fix).toStartWith('bun install --cwd ');
      await runFix(owed?.fix, registry.url.href);
      expect(await load()).toEqual([]);
      // A manifest nobody can install from: the import is all there is to edit.
      await Bun.write(join(checkout, 'package.json'), '{"name":');
      const unread = { code: 'ERR_MODULE_NOT_FOUND', specifier: 'other-pkg' };
      const referrer = join(checkout, 'index.js');
      expect(unresolvedImportFinding({ ...unread, referrer }, root)?.fix).toStartWith(
        'grep -nF -- other-pkg ',
      );
      // Undeclared: added to the package that imports it, never to the app.
      rmSync(join(checkout, 'node_modules'), { recursive: true, force: true });
      await Bun.write(join(checkout, 'package.json'), JSON.stringify(manifest));
      const [undeclared] = await load();
      expect(undeclared?.fix).toStartWith('bun add inner-pkg --cwd ');
      await runFix(undeclared?.fix, registry.url.href);
      expect(await load()).toEqual([]);
    } finally {
      registry.stop(true);
      rmSync(join(root, 'node_modules/linked-pkg'));
      for (const path of [dir, checkout]) rmSync(path, { recursive: true, force: true });
    }
  }, 30_000);

  // What a linked checkout installed is its own: a reinstall in the app writes none of it.
  test("a linked package's own installed dependency is repaired in its checkout", async () => {
    const dir = join(root, 'apps/web/app/nested');
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), "x-linked 'install-")));
    const manifest = {
      name: 'nest-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'hurt-pkg': '1.0.0', 'outer-pkg': '1.0.0' },
    };
    const inner = { 'inner-pkg': '1.0.0' };
    const registry = registryOf({
      'hurt-pkg': {
        tarball: await packageTarball('hurt-pkg', "export { x } from './part.js';\n", {}, [
          ['part.js', 'export const x = 1;\n'],
        ]),
      },
      'outer-pkg': {
        tarball: await packageTarball(
          'outer-pkg',
          "export { x as y } from 'inner-pkg';\nexport { x as z } from 'host-pkg';\n",
          inner,
        ),
        dependencies: inner,
      },
      'inner-pkg': { tarball: await packageTarball('inner-pkg', 'export const x = 1;\n') },
      'host-pkg': { tarball: await packageTarball('host-pkg', 'export const x = 1;\n') },
    });
    const appManifest = join(root, 'package.json');
    const before = '{ "name": "fixture", "version": "0.0.0" }\n';
    try {
      await Bun.write(appManifest, before);
      await Bun.write(join(checkout, 'package.json'), JSON.stringify(manifest));
      const source = "export { x } from 'hurt-pkg';\nexport { y, z } from 'outer-pkg';\n";
      await Bun.write(join(checkout, 'index.js'), source);
      symlinkSync(checkout, join(root, 'node_modules/nest-pkg'));
      await Bun.write(join(dir, 'a.ts'), "export { x, y, z } from 'nest-pkg';\n");
      const at = quoteArg(checkout);
      await runFix(`bun install --cwd ${at}`, registry.url.href);
      // Nothing declares it, so the checkout it is missing from is the one to add it to.
      const [owed] = await load();
      expect(owed?.fix).toBe(`bun add host-pkg --cwd ${at}`);
      await runFix(owed?.fix, registry.url.href);
      expect(await load()).toEqual([]);
      const part = join(checkout, 'node_modules/hurt-pkg/part.js');
      rmSync(part);
      const [damaged] = await load();
      expect(damaged?.fix).toStartWith(`bun install --force --cwd ${at}   # `);
      await runFix(damaged?.fix, registry.url.href);
      expect(await Bun.file(part).exists()).toBe(true);
      expect(await load()).toEqual([]);
      rmSync(join(checkout, 'node_modules/inner-pkg'), { recursive: true });
      const [pruned] = await load();
      expect(pruned?.fix).toStartWith(`bun install --cwd ${at}   # `);
      await runFix(pruned?.fix, registry.url.href);
      expect(await load()).toEqual([]);
      expect(await Bun.file(appManifest).text()).toBe(before);
    } finally {
      registry.stop(true);
      rmSync(join(root, 'node_modules/nest-pkg'));
      for (const path of [dir, checkout]) rmSync(path, { recursive: true, force: true });
    }
  }, 30_000);

  // Both under the app, and one line for both: `--cwd` names the install that wrote the package. A
  // checkout with a lockfile of its own is repaired there; from a workspace `bun` finds the app's.
  test.each([
    ['a standalone checkout', 'vendor/x', [] as string[], 'vendor/x/bun.lock'],
    ['a workspace', 'packages/x', ['packages/*'], 'bun.lock'],
  ])(
    '%s inside the app is repaired where it was installed',
    async (_what, inside, workspaces, lock) => {
      const dir = join(root, 'apps/web/app/inside');
      const own = realpathSync(root);
      const at = quoteArg(join(own, inside));
      const reset = (): void => {
        for (const path of [
          'node_modules',
          'bun.lock',
          'bunfig.toml',
          inside,
          'local',
          'apps/web/app/inside',
        ]) {
          rmSync(join(root, path), { recursive: true, force: true });
        }
      };
      const inner = { 'inner-pkg': '1.0.0' };
      const source = "export { x } from './part.js';\nexport { x as y } from 'inner-pkg';\n";
      const part: readonly [string, string] = ['part.js', 'export const x = 1;\n'];
      const plain = await packageTarball('inner-pkg', 'export const x = 1;\n');
      const registry = registryOf({
        'hurt-pkg': {
          tarball: await packageTarball('hurt-pkg', source, inner, [part]),
          dependencies: inner,
        },
        'inner-pkg': { tarball: plain },
        'host-pkg': { tarball: await packageTarball('host-pkg', 'export const x = 1;\n') },
      });
      try {
        reset();
        // The app's own copies, so a workspace's cannot be hoisted: it is installed in the workspace.
        for (const name of ['hurt-pkg', 'inner-pkg']) {
          const local = { name, version: '9.0.0', main: 'index.js' };
          await Bun.write(join(root, 'local', name, 'package.json'), JSON.stringify(local));
          await Bun.write(join(root, 'local', name, 'index.js'), 'export {};\n');
        }
        const manifest = JSON.stringify({
          name: 'fixture',
          version: '0.0.0',
          workspaces,
          dependencies: {
            'hurt-pkg': 'file:./local/hurt-pkg',
            'inner-pkg': 'file:./local/inner-pkg',
          },
        });
        await Bun.write(join(root, 'package.json'), manifest);
        const owes = { 'hurt-pkg': '1.0.0', ...inner };
        const member = { name: 'x', version: '1.0.0', main: 'index.js', dependencies: owes };
        await Bun.write(join(root, inside, 'package.json'), JSON.stringify(member));
        await Bun.write(join(root, inside, 'index.js'), "export { x, y } from 'hurt-pkg';\n");
        await Bun.write(
          join(dir, 'a.ts'),
          `export { x, y } from '../../../../${inside}/index.js';\n`,
        );
        // Nested, not in the isolated linker's store at the root: the shape a `--cwd` is for.
        const hoisted = '[install]\nlinker = "hoisted"\n';
        await Bun.write(join(root, 'bunfig.toml'), hoisted);
        await Bun.write(join(root, inside, 'bunfig.toml'), hoisted);
        await runFix('bun install', registry.url.href);
        await runFix(`bun install --cwd ${at}`, registry.url.href);
        expect(await load()).toEqual([]);

        const torn = join(root, inside, 'node_modules/hurt-pkg/part.js');
        rmSync(torn);
        const [damaged] = await load();
        expect(damaged?.fix).toStartWith(`bun install --force --cwd ${at}   # `);
        await runFix(damaged?.fix, registry.url.href);
        expect(await Bun.file(torn).exists()).toBe(true);
        expect(await load()).toEqual([]);

        await Bun.write(
          join(root, inside, 'node_modules/hurt-pkg/index.js'),
          "export { x, x as y } from 'host-pkg';\n",
        );
        const [owed] = await load();
        expect(owed?.fix).toBe(`bun add host-pkg --cwd ${at}`);
        await runFix(owed?.fix, registry.url.href);
        expect(await load()).toEqual([]);
        // Added to the package that brought the importer in, and recorded in the one lockfile it has.
        const added = (await Bun.file(join(root, inside, 'package.json')).json()) as typeof member;
        expect(Object.keys(added.dependencies)).toContain('host-pkg');
        expect(await Bun.file(join(root, 'package.json')).text()).toBe(manifest);
        expect(await Bun.file(join(root, lock)).text()).toContain('host-pkg');
        expect(await Bun.file(join(root, inside, 'bun.lock')).exists()).toBe(lock !== 'bun.lock');
      } finally {
        registry.stop(true);
        reset();
      }
    },
    60_000,
  );
});
