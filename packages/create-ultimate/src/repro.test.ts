// `create-ultimate repro <bundle.json>`: the scratch app it writes — the reproducer under `repro/`
// importing the scratch app's own db package, the bundle beside it, every `@ultimat3/*` linked to a
// framework checkout — and what it refuses to open. `repro` alone is still an app named `repro`.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no synchronous existence check.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join, resolve } from 'node:path';
import { createApp } from './index';

const parent = mkdtempSync(join(tmpdir(), 'create-ultimate-repro-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const CHECKOUT = resolve(import.meta.dir, '..', '..', '..');

const BUNDLE = {
  format: 'x-repro-bundle/1',
  id: 'req-1',
  code: 'X_PLANTED',
  framework: { packages: { '@ultimat3/core': ['31.27.0'] } },
  subject: { name: 'createPost' },
  reproducer: {
    file: 'repro/repro-req1.contract.test.ts',
    source: ["import { driver } from '@app/db';", "import '../apps/web/api';", ''],
  },
};

const fileWith = async (name: string, value: unknown): Promise<string> => {
  const path = join(parent, name);
  await Bun.write(path, JSON.stringify(value));
  return path;
};

const run = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
  const lines: string[] = [];
  const code = await createApp({ argv, cwd: parent, write: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
};

const codeOf = (out: string): string | undefined =>
  (JSON.parse(out) as { findings?: { code: string }[] }).findings?.[0]?.code;

describe('create-ultimate repro', () => {
  test('a bundle opens into a scratch app linked to the framework checkout', async () => {
    const path = await fileWith('bundle.json', BUNDLE);
    const { code, out } = await run(['repro', path, '--framework', CHECKOUT, '--json']);
    expect(code).toBe(0);
    const dir = join(parent, 'repro-req1');
    expect(JSON.parse(out)).toMatchObject({ ok: true, data: { dir, framework: CHECKOUT } });
    const test = await Bun.file(join(dir, 'repro/repro-req1.contract.test.ts')).text();
    expect(test).toContain("import { driver } from '@repro-req1/db';");
    expect(await Bun.file(join(dir, 'repro/bundle.json')).json()).toEqual(BUNDLE);
    const pkg = (await Bun.file(join(dir, 'package.json')).json()) as {
      overrides: Record<string, string>;
    };
    expect(pkg.overrides['@ultimat3/core']).toBe(`file:${join(CHECKOUT, 'packages', 'core')}`);
    expect(existsSync(join(dir, 'apps/web/api/index.ts'))).toBe(true);
  });

  test('a second open into the same directory is refused, nothing overwritten', async () => {
    const path = await fileWith('bundle.json', BUNDLE);
    const { code, out } = await run(['repro', path, '--framework', CHECKOUT, '--json']);
    expect(code).toBe(1);
    expect(codeOf(out)).toBe('X_CLI_BAD_FLAG');
  });

  test('a JSON file that is no bundle, and a reproducer path that climbs, are refused', async () => {
    const plain = await fileWith('plain.json', { hello: 'world' });
    const climbing = await fileWith('climb.json', {
      ...BUNDLE,
      id: 'climb',
      reproducer: { file: 'repro/../../evil.test.ts', source: ['x'] },
    });
    const otherFormat = await fileWith('old.json', {
      ...BUNDLE,
      id: 'old',
      format: 'x-repro-bundle/0',
    });
    for (const path of [plain, climbing, otherFormat, join(parent, 'missing.json')]) {
      const { code, out } = await run(['repro', path, '--json']);
      expect(code).toBe(1);
      expect(codeOf(out)).toBe('X_REPRO_BUNDLE_INVALID');
    }
    expect(existsSync(join(parent, 'repro-climb'))).toBe(false);
    expect(existsSync(join(parent, 'repro-old'))).toBe(false);
  });

  test('`repro` alone is still an app named repro', async () => {
    const { code, out } = await run(['repro', '--dry-run', '--json']);
    expect(code).toBe(0);
    expect((JSON.parse(out) as { command: string }).command).toBe('new');
  });
});
