// `installMissingGuards` against a CLI shaped like the real `x g guard --json`: its `data.files`
// lists the refreshed `x.manifest.json` / `openapi.json` beside the guard, so a rollback must put
// those back as they were — never delete a file the app committed before the run.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fsCodemodApp } from './codemods/engine-fs';
import { codemod as vendoredGuards } from './codemods/vendored-guards';
import type { ExecResult } from './exec';
import { SHIPPED_GUARD_CONFIG } from './guards-built-in';
import { shippedGuardSource } from './templates/scaffold-guards';
import { installMissingGuards } from './upgrade-guards';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = '{"committed":"manifest"}\n';
const OPENAPI = '{"committed":"openapi"}\n';

const app = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-guards-'));
  dirs.push(dir);
  await Bun.write(join(dir, 'x.manifest.json'), MANIFEST);
  await Bun.write(join(dir, 'openapi.json'), OPENAPI);
  return dir;
};

const answer = (stdout: string): ExecResult => ({
  command: [],
  code: 0,
  ok: true,
  stdout,
  stderr: '',
  durationMs: 1,
});

const onDisk = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  for await (const path of new Bun.Glob('guards/*.ts').scan({ cwd: root })) {
    if (!path.endsWith('.test.ts')) names.push(path.replaceAll('\\', '/').slice(7, -3));
  }
  return names.sort();
};

/** The real generator's shape: the guard, its test, and both refreshed artifacts in `data.files`. */
const cli =
  (root: string, breaks: ReadonlyMap<string, number>) => async (args: readonly string[]) => {
    if (args[0] === 'g') {
      const name = args[2] ?? '';
      await Bun.write(join(root, `guards/${name}.ts`), `// ${name}\n`);
      await Bun.write(join(root, `guards/${name}.test.ts`), `// ${name}\n`);
      const guards = await onDisk(root);
      await Bun.write(join(root, 'x.manifest.json'), `${JSON.stringify({ guards })}\n`);
      await Bun.write(join(root, 'openapi.json'), `${JSON.stringify({ guards })}\n`);
      const files = [
        `guards/${name}.ts`,
        `guards/${name}.test.ts`,
        'x.manifest.json',
        'openapi.json',
      ];
      return answer(JSON.stringify({ ok: true, data: { files } }));
    }
    let count = 0;
    for (const name of await onDisk(root)) count += breaks.get(name) ?? 0;
    return answer(
      JSON.stringify({
        steps: [{ name: 'boundaries', findings: Array(count).fill({ code: 'X' }) }],
      }),
    );
  };

const missing = (...names: readonly string[]) =>
  names.map((name) => ({ name, add: `x g guard ${name}` }));

describe('unit · installMissingGuards rollback', () => {
  test('a withheld guard leaves the committed manifest and openapi.json as they were', async () => {
    const root = await app();
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 3]])),
      root,
      missing: missing('no-eval'),
    });
    expect(done.withheld).toEqual([{ name: 'no-eval', add: 'x g guard no-eval', findings: 3 }]);
    expect(await Bun.file(join(root, 'guards/no-eval.ts')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'x.manifest.json')).text()).toBe(MANIFEST);
    expect(await Bun.file(join(root, 'openapi.json')).text()).toBe(OPENAPI);
  });

  test('of two, the artifacts end as the installed guard alone left them', async () => {
    const root = await app();
    const done = await installMissingGuards({
      cli: cli(root, new Map([['raw-fetch', 2]])),
      root,
      missing: missing('no-eval', 'raw-fetch'),
    });
    expect(done.installed).toEqual(['no-eval']);
    const consistent = `${JSON.stringify({ guards: ['no-eval'] })}\n`;
    expect(await Bun.file(join(root, 'x.manifest.json')).text()).toBe(consistent);
    expect(await Bun.file(join(root, 'openapi.json')).text()).toBe(consistent);
  });

  test('two withheld guards, rolled back newest first, leave the committed bytes', async () => {
    const root = await app();
    const done = await installMissingGuards({
      cli: cli(
        root,
        new Map([
          ['no-eval', 1],
          ['raw-fetch', 2],
        ]),
      ),
      root,
      missing: missing('no-eval', 'raw-fetch'),
    });
    expect(done.installed).toEqual([]);
    expect(await Bun.file(join(root, 'x.manifest.json')).text()).toBe(MANIFEST);
    expect(await Bun.file(join(root, 'openapi.json')).text()).toBe(OPENAPI);
  });

  test('a listed artifact the app never had is removed with the guard', async () => {
    const root = await app();
    rmSync(join(root, 'openapi.json'));
    await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 1]])),
      root,
      missing: missing('no-eval'),
    });
    expect(await Bun.file(join(root, 'openapi.json')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'x.manifest.json')).text()).toBe(MANIFEST);
  });
});

// Guards run built in now; `x upgrade` carries a vendored tree across with the `vendored-guards`
// codemod, on the app's real disk. What an author changed survives it, as config or as their file.
describe('unit · x upgrade · a locally edited guard is preserved, never overwritten', () => {
  test('a severity edit becomes a config row; any other edit is kept byte for byte', async () => {
    const root = await app();
    const shipped = shippedGuardSource('raw-colour') ?? '';
    const reportOnly = shipped.replace(
      'export const guard: Guard = {\n',
      "export const guard: Guard = {\n  severity: 'warning',\n",
    );
    const edited = `${shippedGuardSource('raw-fetch') ?? ''}// our vendor client is exempt\n`;
    expect(reportOnly).not.toBe(shipped);
    await Bun.write(join(root, 'guards/raw-colour.ts'), reportOnly);
    await Bun.write(join(root, 'guards/raw-fetch.ts'), edited);
    const result = await vendoredGuards.run(fsCodemodApp(root));
    expect(await Bun.file(join(root, 'guards/raw-colour.ts')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'guards/app-raw-fetch.ts')).text()).toBe(edited);
    const config = JSON.parse(await Bun.file(join(root, SHIPPED_GUARD_CONFIG)).text());
    expect(config.severity).toMatchObject({ 'raw-colour': 'warning', 'raw-fetch': 'off' });
    expect(result.skipped.map((skip) => skip.path)).toEqual(['guards/app-raw-fetch.ts']);
  });
});
