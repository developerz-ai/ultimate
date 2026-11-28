// `x upgrade` and the shipped guards a hop brings: written when the tree breaks none of them,
// withheld (and listed with the count) when it does, never touched when the app edited its copy.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fixture, git, recording, removeFixtures, run } from './cmd-upgrade-fixture';

afterEach(removeFixtures);

const doctor = (...names: readonly string[]): string =>
  JSON.stringify({
    ok: true,
    data: {
      guards: {
        missing: names.map((name) => ({ name, add: `x g guard ${name}` })),
        differs: [{ name: 'no-raw-colors', refresh: 'x g guard no-raw-colors --force' }],
      },
    },
  });

const exists = (dir: string, path: string): Promise<boolean> => Bun.file(join(dir, path)).exists();

describe('unit · x upgrade, the shipped guards a hop brings', () => {
  test('a missing guard the tree breaks nowhere is written, uncommitted, and the hop stays green', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ doctor: doctor('no-eval') });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(0);
    expect(output.data?.guards).toEqual({
      reported: true,
      missing: [],
      differs: [{ name: 'no-raw-colors', refresh: 'x g guard no-raw-colors --force' }],
      installed: ['no-eval'],
      withheld: [],
    });
    expect(await exists(dir, 'guards/no-eval.ts')).toBe(true);
    expect(await exists(dir, 'guards/no-eval.test.ts')).toBe(true);
    expect(await git(dir, 'status', '--porcelain')).toContain('guards/');
    expect(spawned.slice(spawned.indexOf('x doctor'))).toEqual([
      'x doctor',
      'x verify --only boundaries',
      'x g',
      'x verify --only boundaries',
      'x exercise',
      'x verify',
    ]);
  });

  test('a guard the tree already breaks is taken back out and listed with its count', async () => {
    const dir = await fixture();
    const { runner } = recording({
      doctor: doctor('no-eval'),
      guardFindings: new Map([['no-eval', 3]]),
    });
    const { code, output, lines } = await run(dir, runner);
    expect(code).toBe(0);
    expect(output.data?.guards).toMatchObject({
      missing: [{ name: 'no-eval', add: 'x g guard no-eval' }],
      installed: [],
      withheld: [{ name: 'no-eval', add: 'x g guard no-eval', findings: 3 }],
    });
    expect(await exists(dir, 'guards/no-eval.ts')).toBe(false);
    expect(await exists(dir, 'guards/no-eval.test.ts')).toBe(false);
    expect(lines.join('\n')).toContain('x g guard no-eval');
  });

  test('of two, only the one the tree breaks is withheld; the other is written', async () => {
    const dir = await fixture();
    const { runner } = recording({
      doctor: doctor('no-eval', 'raw-fetch'),
      guardFindings: new Map([['raw-fetch', 2]]),
    });
    const { output } = await run(dir, runner);
    expect(output.data?.guards).toMatchObject({
      installed: ['no-eval'],
      withheld: [{ name: 'raw-fetch', add: 'x g guard raw-fetch', findings: 2 }],
    });
    expect(await exists(dir, 'guards/no-eval.ts')).toBe(true);
    expect(await exists(dir, 'guards/raw-fetch.ts')).toBe(false);
  });

  test('a CLI whose boundaries count cannot be read installs nothing, and lists each as unmeasured', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({
      doctor: doctor('no-eval'),
      boundaries: 'error: unknown flag --only\n',
    });
    const { output } = await run(dir, runner);
    expect(spawned).not.toContain('x g');
    expect(output.data?.guards).toMatchObject({
      installed: [],
      withheld: [{ name: 'no-eval', add: 'x g guard no-eval', findings: null }],
    });
    expect(await exists(dir, 'guards/no-eval.ts')).toBe(false);
  });

  test('a generator that refuses leaves the guard listed, unmeasured', async () => {
    const dir = await fixture();
    const { runner } = recording({ doctor: doctor('no-eval'), generateCode: 1 });
    const { output } = await run(dir, runner);
    expect(output.data?.guards).toMatchObject({
      installed: [],
      withheld: [{ name: 'no-eval', findings: null }],
    });
  });

  test('an app-edited guard is listed, never rewritten', async () => {
    const dir = await fixture();
    const { runner } = recording({ doctor: doctor('no-eval') });
    await run(dir, runner);
    expect(await git(dir, 'diff', '--', 'guards/no-raw-colors.ts')).toBe('');
  });

  test('the human form says which guard was written and which withheld, with its count', async () => {
    const dir = await fixture();
    const { runner } = recording({
      doctor: doctor('no-eval', 'raw-fetch'),
      guardFindings: new Map([['raw-fetch', 2]]),
    });
    const { lines } = await run(dir, runner, [], { json: false });
    const text = lines.join('\n');
    expect(text).toContain('guard installed: guards/no-eval.ts');
    expect(text).toContain('breaks it in 2 place(s) — yours to take: x g guard raw-fetch');
    expect(text).not.toContain('⟦');
  });

  test('nothing missing spawns no count and no generator', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ doctor: doctor() });
    await run(dir, runner);
    expect(spawned).not.toContain('x verify --only boundaries');
    expect(spawned).not.toContain('x g');
  });
});
