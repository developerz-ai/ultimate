// A load failing on an import reports one instruction per missing thing, and the instruction works.
// The load runs in a child process: Bun's resolver and the registries are per-process.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no symlink API and no recursive remove.
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { childLoad } from './app-load-child-fixture';
import { installablePackage, unresolvedImportFinding } from './app-load-unresolved';
import { exec } from './exec';
import type { Finding } from './output';
import { findingFrom } from './output';
import { collapseFindings } from './output-findings';

let root = '';

const load = (): Promise<readonly Finding[]> => childLoad(root);

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
      // A peer or an undeclared import: the install is as complete as it was asked to be.
      await Bun.write(manifest, '{"name":"outer","peerDependencies":{"@acme/inner":"1.0.0"}}');
      expect(find()?.fix).toBe('bun add @acme/inner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The app above declares it, and an app's manifest says nothing about what `outer` was owed.
  test.each([
    ['half-written', (path: string) => Bun.write(path, '{"name":"outer","dependencies":')],
    ['a list', (path: string) => Bun.write(path, '[]')],
    ['null', (path: string) => Bun.write(path, 'null')],
    ['a directory', (path: string) => Bun.write(join(path, 'x'), '')],
    ['gone', () => Promise.resolve(0)],
  ])(
    'a manifest that is %s keeps the finding, and the package is reinstalled',
    async (_what, make) => {
      const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-manifest-'));
      try {
        await Bun.write(
          join(dir, 'package.json'),
          '{"name":"app","dependencies":{"inner":"1.0.0"}}',
        );
        for (const outer of ['node_modules/outer', 'node_modules/@acme/scoped']) {
          const referrer = join(dir, outer, 'a.ts');
          await Bun.write(referrer, '');
          await make(join(dir, outer, 'package.json'));
          const finding = unresolvedImportFinding(
            { code: 'ERR_MODULE_NOT_FOUND', specifier: 'inner', referrer },
            dir,
          );
          expect([finding?.code, finding?.cause]).toEqual([
            'X_APP_IMPORT_UNRESOLVED',
            `${outer}/a.ts imports inner, which is not installed`,
          ]);
          expect(finding?.fix).toStartWith('bun install --force   # ');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('a referrer whose link cannot be followed keeps the finding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-loop-'));
    try {
      const referrer = join(dir, 'a.ts');
      symlinkSync(join(dir, 'b.ts'), referrer);
      symlinkSync(referrer, join(dir, 'b.ts'));
      const finding = unresolvedImportFinding(
        { code: 'ERR_MODULE_NOT_FOUND', specifier: 'gone', referrer },
        dir,
      );
      expect([finding?.at, finding?.fix]).toEqual(['a.ts', 'bun add gone']);
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

  // The app's own install, wherever its linker put the package: run where the app is.
  test.each([
    ['the app', 'mono/apps/web', 'mono/apps/web/node_modules/outer'],
    ['a workspace of it', 'mono/apps/web', 'mono/apps/web/packages/p/node_modules/outer'],
    ['the workspace root above it', 'mono/apps/web', 'mono/node_modules/outer'],
    ['an isolated store', 'mono/apps/web', 'mono/node_modules/.bun/outer@1/node_modules/outer'],
    [
      'an app that is itself installed',
      'x/node_modules/app',
      'x/node_modules/app/node_modules/outer',
    ],
  ])('installed by %s: no --cwd', async (_what, app, outer) => {
    const dir = mkdtempSync(join(tmpdir(), 'x-unresolved-root-'));
    try {
      const referrer = join(dir, outer, 'a.ts');
      await Bun.write(referrer, '');
      await Bun.write(
        join(dir, outer, 'package.json'),
        '{"name":"outer","dependencies":{"in":"1"}}',
      );
      await Bun.write(join(dir, app, 'app.config.ts'), '');
      const fixOf = (specifier: string) =>
        unresolvedImportFinding(
          { code: 'ERR_MODULE_NOT_FOUND', specifier, referrer },
          join(dir, app),
        )?.fix;
      for (const specifier of ['./gone', 'in', 'peer']) {
        expect(fixOf(specifier)).not.toContain('--cwd');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a checkout whose name holds a newline ends no comment, and no line', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'x-unresolved-newline-')));
    try {
      const checkout = join(dir, 'c\ntouch pwned\n#');
      const referrer = join(checkout, 'node_modules/outer/a.ts');
      await Bun.write(referrer, '');
      const outer = join(checkout, 'node_modules/outer/package.json');
      await Bun.write(outer, '{"name":"outer","dependencies":{"in":"1"}}');
      await Bun.write(join(checkout, 'node_modules/has/package.json'), '{"name":"has"}');
      await Bun.write(join(dir, 'app/app.config.ts'), '');
      for (const specifier of ['./gone', 'in', 'peer', 'has/nope']) {
        const error = { code: 'ERR_MODULE_NOT_FOUND', specifier, referrer };
        const fix = unresolvedImportFinding(error, join(dir, 'app'))?.fix ?? '';
        expect(fix).toContain('--cwd ');
        // `bun` as a no-op: the line is parsed and every command in it is run.
        await exec(['sh', '-c', `bun() { :; }; ${fix}`], { cwd: dir });
        expect(await Bun.file(join(dir, 'pwned')).exists()).toBe(false);
      }
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
