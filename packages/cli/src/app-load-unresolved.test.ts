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
const packageTarball = async (name: string, source: string): Promise<Uint8Array<ArrayBuffer>> => {
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
    entry('package/package.json', JSON.stringify({ name, version: '1.0.0', main: 'index.js' })),
    entry('package/index.js', source),
    new Uint8Array(1024),
  ]);
  return new Uint8Array(Bun.gzipSync(new Uint8Array(await tar.arrayBuffer())));
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
    expect(findings[0]?.fix).toStartWith('grep -n ../nowhere/repo apps/web/app/rel/a.ts   # ');
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
    const registry = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname, origin } = new URL(request.url);
        if (pathname.endsWith('.tgz')) return new Response(tarball);
        return Response.json({
          name: 'fix-truth-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'fix-truth-pkg',
              version: '1.0.0',
              dist: { tarball: `${origin}/fix-truth-pkg-1.0.0.tgz` },
            },
          },
        });
      },
    });
    try {
      const child = Bun.spawn(['sh', '-c', finding?.fix ?? ''], {
        cwd: root,
        env: {
          ...Bun.env,
          BUN_CONFIG_REGISTRY: registry.url.href,
          BUN_INSTALL_CACHE_DIR: join(root, '.bun-cache'),
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const said = await new Response(child.stderr).text();
      expect({ code: await child.exited, said }).toEqual({ code: 0, said: expect.any(String) });
      expect(await load()).toEqual([]);
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
    expect(finding?.fix).toStartWith("grep -n 'a;id' ");
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
