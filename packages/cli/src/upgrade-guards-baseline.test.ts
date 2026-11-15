// A withheld guard that the installed CLI can hold at a baseline: kept on disk, its measured count
// merged into `x.verify.json` as `guardBaseline` — never over a key the app wrote — and reported in
// `baselined`. A CLI that ignores the key leaves the count risen, so the guard is withheld as before.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult } from './exec';
import { installMissingGuards } from './upgrade-guards';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const app = async (floor?: string): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-guards-baseline-'));
  dirs.push(dir);
  if (floor !== undefined) await Bun.write(join(dir, VERIFY_FLOOR_FILE), floor);
  return dir;
};

const answer = (stdout: string, ok = true): ExecResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
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

const baselineOf = async (root: string): Promise<Record<string, number>> => {
  const file = Bun.file(join(root, VERIFY_FLOOR_FILE));
  if (!(await file.exists())) return {};
  try {
    const parsed = JSON.parse(await file.text()) as { guardBaseline?: Record<string, number> };
    return parsed.guardBaseline ?? {};
  } catch {
    return {};
  }
};

/**
 * `x g guard` and `x verify --only boundaries`, the second judging `guardBaseline` the way this
 * release's `guards.ts` does when `honours` — at or under: no finding; over: every one and one more.
 */
const cli =
  (root: string, breaks: ReadonlyMap<string, number>, honours: boolean) =>
  async (args: readonly string[]) => {
    if (args[0] === 'g') {
      const name = args[2] ?? '';
      await Bun.write(join(root, `guards/${name}.ts`), `// ${name}\n`);
      return answer(JSON.stringify({ ok: true, data: { files: [`guards/${name}.ts`] } }));
    }
    const baseline = honours ? await baselineOf(root) : {};
    let count = 0;
    for (const name of await onDisk(root)) {
      const hits = breaks.get(name) ?? 0;
      const allowed = baseline[name];
      count += allowed === undefined ? hits : hits <= allowed ? 0 : hits + 1;
    }
    return answer(
      JSON.stringify({
        steps: [{ name: 'boundaries', findings: Array(count).fill({ code: 'X' }) }],
      }),
    );
  };

const missing = (...names: readonly string[]) =>
  names.map((name) => ({ name, add: `x g guard ${name}` }));

describe('unit · a withheld guard installs at its baseline', () => {
  test('kept, counted into guardBaseline beside the keys the app wrote, and reported', async () => {
    const root = await app('{"steps":["unit"],"isolate":true}\n');
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 3]]), true),
      root,
      missing: missing('no-eval', 'raw-fetch'),
    });
    expect(done.installed).toEqual(['no-eval', 'raw-fetch']);
    expect(done.withheld).toEqual([]);
    expect(done.baselined).toEqual([{ name: 'no-eval', findings: 3 }]);
    expect(await onDisk(root)).toEqual(['no-eval', 'raw-fetch']);
    const floor = JSON.parse(await Bun.file(join(root, VERIFY_FLOOR_FILE)).text()) as unknown;
    expect(floor).toEqual({ steps: ['unit'], isolate: true, guardBaseline: { 'no-eval': 3 } });
  });

  test('no floor file: one is written that requires no step', async () => {
    const root = await app();
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 2]]), true),
      root,
      missing: missing('no-eval'),
    });
    expect(done.baselined).toEqual([{ name: 'no-eval', findings: 2 }]);
    expect(JSON.parse(await Bun.file(join(root, VERIFY_FLOOR_FILE)).text())).toEqual({
      steps: [],
      guardBaseline: { 'no-eval': 2 },
    });
  });

  test('a CLI that ignores the key: withheld as before, and the floor put back byte for byte', async () => {
    const committed = '{ "steps": ["unit"] }\n';
    const root = await app(committed);
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 3]]), false),
      root,
      missing: missing('no-eval'),
    });
    expect(done.withheld).toEqual([{ name: 'no-eval', add: 'x g guard no-eval', findings: 3 }]);
    expect(done.baselined).toBeUndefined();
    expect(await onDisk(root)).toEqual([]);
    expect(await Bun.file(join(root, VERIFY_FLOOR_FILE)).text()).toBe(committed);
  });

  test('a baseline the app already wrote for that guard is never touched', async () => {
    const committed = '{"steps":[],"guardBaseline":{"no-eval":1}}\n';
    const root = await app(committed);
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 3]]), true),
      root,
      missing: missing('no-eval'),
    });
    expect(done.withheld.map((guard) => guard.name)).toEqual(['no-eval']);
    expect(await Bun.file(join(root, VERIFY_FLOOR_FILE)).text()).toBe(committed);
  });

  test('a floor file that is not a JSON object is never rewritten', async () => {
    const root = await app('not json');
    const done = await installMissingGuards({
      cli: cli(root, new Map([['no-eval', 3]]), true),
      root,
      missing: missing('no-eval'),
    });
    expect(done.withheld.map((guard) => guard.name)).toEqual(['no-eval']);
    expect(await Bun.file(join(root, VERIFY_FLOOR_FILE)).text()).toBe('not json');
  });
});
