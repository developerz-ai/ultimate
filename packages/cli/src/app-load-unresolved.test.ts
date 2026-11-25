// A load failing on an import reports one instruction per missing thing, and the instruction works.
// The load runs in a child process: Bun's resolver and the registries are per-process.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no symlink API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { installablePackage, unresolvedImportFinding } from './app-load-unresolved';
import type { Finding } from './output';
import { findingFrom } from './output';
import { collapseFindings } from './output-findings';

let root = '';

/** A one-file npm tarball, by hand: a tar header is 512 bytes of fields and a checksum. */
const packageTarball = async (
  name: string,
  source: string,
  dependencies: Readonly<Record<string, string>> = {},
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

const load = async (): Promise<readonly Finding[]> => {
  const script = `import { loadApp } from ${JSON.stringify(join(import.meta.dir, 'app-load.ts'))};
const app = await loadApp(${JSON.stringify(root)});
process.stdout.write(JSON.stringify(app.findings));`;
  const child = Bun.spawn(['bun', '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) return expect.unreachable(`the load crashed: ${err}`);
  return JSON.parse(out) as readonly Finding[];
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-app-load-unresolved-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the app load', () => {
  test('a package nobody installed is one finding, however many modules reach it', async () => {
    const dir = join(root, 'apps/web/app/bare');
    await Bun.write(join(dir, 'a.ts'), "export { x } from 'not-installed-pkg/sub';\n");
    await Bun.write(join(dir, 'b.ts'), "export { x } from 'not-installed-pkg';\n");
    await Bun.write(join(dir, 'c.ts'), "export { x } from './a';\n");
    // The load reports each importer; what a reader gets is the render layer's one line.
    const findings = collapseFindings(await load());
    expect(findings.map((one) => one.code)).toEqual(['X_APP_IMPORT_UNRESOLVED']);
    expect(findings[0]?.meta?.['count']).toBe(3);
    expect(findings[0]?.fix).toBe('bun add not-installed-pkg');
    expect(findings[0]?.at).toBe('apps/web/app/bare/a.ts');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a relative import is an edit in the file that holds it, one each', async () => {
    const dir = join(root, 'apps/web/app/rel');
    await Bun.write(join(dir, 'a.ts'), "export { x } from '../nowhere/repo';\n");
    await Bun.write(join(dir, 'b.ts'), "export { x } from './a';\n");
    const findings = collapseFindings(await load());
    expect(findings.map((one) => one.code)).toEqual(['X_APP_IMPORT_UNRESOLVED']);
    expect(findings[0]?.fix).toStartWith('grep -nF -- ../nowhere/repo apps/web/app/rel/a.ts   # ');
    await Bun.write(join(dir, 'a.ts'), 'export const x = 1;\n');
    expect(await load()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

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
});

describe('the reading', () => {
  test.each([
    ['@ultimat3/mail', '@ultimat3/mail'],
    ['@ultimat3/mail/server', '@ultimat3/mail'],
    ['lodash/x', 'lodash'],
    ['./a', undefined],
    ['../a', undefined],
    ['/abs', undefined],
    ['@/lib/x', undefined],
    ['node:nope', undefined],
  ])('%s', (specifier, pkg) => {
    expect(installablePackage(specifier)).toBe(pkg);
  });

  test('a hostile package name is quoted before it reaches a shell', () => {
    // `installablePackage` already refuses this shape: it lands on the edit, never `bun add`.
    const finding = unresolvedImportFinding(
      { code: 'ERR_MODULE_NOT_FOUND', specifier: 'a;id', referrer: '/app/x.ts' },
      '/app',
    );
    expect(finding?.fix).toStartWith("grep -nF -- 'a;id' ");
  });

  test('an installed package with no such subpath is an edit to the import, never bun add', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-subpath-'));
    try {
      await Bun.write(join(dir, 'node_modules/fake-pkg/package.json'), '{"name":"fake-pkg"}');
      const finding = unresolvedImportFinding(
        {
          code: 'ERR_MODULE_NOT_FOUND',
          specifier: 'fake-pkg/nope',
          referrer: join(dir, 'apps/x.ts'),
        },
        dir,
      );
      expect(finding?.fix).toStartWith('grep -nF -- fake-pkg/nope apps/x.ts   # ');
      expect(finding?.cause).toContain('fake-pkg is installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a specifier grep would read as a pattern or a flag is searched as text', () => {
    const fixOf = (specifier: string) =>
      unresolvedImportFinding(
        { code: 'ERR_MODULE_NOT_FOUND', specifier, referrer: '/app/x.ts' },
        '/app',
      )?.fix;
    expect(fixOf('./[')).toStartWith("grep -nF -- './[' x.ts");
  });

  test("outside a scan, an installed package's own import is told as that, not as the app's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-outside-'));
    try {
      const referrer = join(dir, 'node_modules/outer/src/deep/a.ts');
      await Bun.write(referrer, '');
      // A nameless manifest between (`{"type":"module"}`) is not the package's.
      await Bun.write(join(dir, 'node_modules/outer/src/package.json'), '{"type":"module"}');
      const manifest = join(dir, 'node_modules/outer/package.json');
      const find = () =>
        unresolvedImportFinding(
          { code: 'ERR_MODULE_NOT_FOUND', specifier: '@acme/inner/sub', referrer },
          dir,
        );
      await Bun.write(manifest, '{"name":"outer","dependencies":{"@acme/inner":"1.0.0"}}');
      expect(find()?.cause).toBe(
        'node_modules/outer/src/deep/a.ts imports @acme/inner, which is not installed',
      );
      expect(find()?.fix).toStartWith('bun install --frozen-lockfile   # ');
      // A peer, an undeclared import or an unreadable manifest: the install is as complete as asked.
      await Bun.write(manifest, '{"name":"outer","peerDependencies":{"@acme/inner":"1.0.0"}}');
      expect(find()?.fix).toBe('bun add @acme/inner');
      await Bun.write(manifest, '{"name":"outer","dependencies":');
      expect(find()?.fix).toBe('bun add @acme/inner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inside an installed package nothing is an edit: a missing file or subpath is a reinstall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-damaged-'));
    try {
      const referrer = join(dir, 'node_modules/outer/a.ts');
      await Bun.write(referrer, '');
      await Bun.write(join(dir, 'node_modules/inner/package.json'), '{"name":"inner"}');
      const find = (specifier: string) =>
        unresolvedImportFinding({ code: 'ERR_MODULE_NOT_FOUND', specifier, referrer }, dir);
      expect([find('./gone')?.cause, find('./gone')?.fix]).toEqual([
        'node_modules/outer/a.ts imports "./gone", which resolves to no file',
        'bun install --force   # the installed copy lacks what it imports: reinstall it',
      ]);
      expect(find('inner/gone')?.cause).toContain('inner is installed with no such subpath');
      expect(find('inner/gone')?.fix).toEndWith('bun why inner, then align the two versions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the app's own manifest declaring it is not an installed package declaring it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-own-'));
    try {
      await Bun.write(join(dir, 'package.json'), '{"name":"app","dependencies":{"gone":"1.0.0"}}');
      const referrer = join(dir, 'apps/web/app/a.ts');
      await Bun.write(referrer, '');
      const finding = unresolvedImportFinding(
        { code: 'ERR_MODULE_NOT_FOUND', specifier: 'gone', referrer },
        dir,
      );
      expect([finding?.cause, finding?.fix]).toEqual([
        'an app module imports gone, which is not installed',
        'bun add gone',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('any other failure is not this one', () => {
    expect(unresolvedImportFinding(new TypeError('boom'), '/app')).toBeUndefined();
  });

  test('outside the scan too: a throw reaching the last renderer is the same instruction', () => {
    const finding = findingFrom({
      code: 'ERR_MODULE_NOT_FOUND',
      specifier: 'not-installed',
      referrer: `${process.cwd()}/app.config.ts`,
    });
    expect(finding.code).toBe('X_APP_IMPORT_UNRESOLVED');
    expect(finding.fix).toBe('bun add not-installed');
  });
});
