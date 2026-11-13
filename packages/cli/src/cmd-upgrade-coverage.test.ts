// `x upgrade` across a Bun-floor move: the unit suite measured once, and a floor the new Bun counts
// under moved to what it measured — in the hop's diff, dated, the old `why` kept — never otherwise.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { createUpgradeCommand } from './cmd-upgrade';
import { fixture, REQUIRED_BUN, recording, removeFixtures } from './cmd-upgrade-fixture';
import { parseArgs } from './parse';
import { SPECS } from './registry';

afterEach(removeFixtures);

const FLOOR = {
  steps: ['typecheck', 'unit'],
  coverage: {
    lines: 76,
    funcs: 64,
    why: 'page renders run in e2e only.',
    exclude: [{ glob: 'apps/web/e2e/**', why: 'browser fixtures' }],
  },
};

const unitDocument = (
  numbers: { lines: number; funcs: number } | undefined,
  codes: readonly string[],
): string =>
  JSON.stringify({
    ok: codes.length === 0,
    steps: [
      {
        name: 'unit',
        ok: codes.length === 0,
        findings: codes.map((code) => ({ code, cause: 'c', fix: 'x verify --only unit --json' })),
      },
    ],
    data: numbers === undefined ? {} : { coverage: { unit: { ...numbers, files: 90 } } },
  });

const BELOW = unitDocument({ lines: 76.38, funcs: 63.31 }, ['X_COVERAGE_BELOW_FLOOR']);

const hop = async (
  dir: string,
  script: Parameters<typeof recording>[0],
): Promise<{
  data: Record<string, unknown>;
  lines: readonly string[];
  spawned: readonly string[];
}> => {
  const { runner, spawned } = recording({ doctor: JSON.stringify({ ok: true }), ...script });
  // 23:30 UTC on the 11th is the 12th in Tokyo: the date written is the UTC one.
  const command = createUpgradeCommand(
    () => undefined,
    () => new Date('2026-11-11T23:30:00Z'),
  );
  const result = await command.run({
    args: parseArgs(['upgrade', '--json'], SPECS),
    cwd: dir,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });
  return { data: result.data as Record<string, unknown>, lines: result.lines ?? [], spawned };
};

const floorFile = async (dir: string): Promise<typeof FLOOR> =>
  (await Bun.file(join(dir, 'x.verify.json')).json()) as typeof FLOOR;

describe('unit · x upgrade, a Bun-floor hop and the coverage floor', () => {
  test('a floor the new Bun measures under moves to the measurement, dated, the old why kept', async () => {
    const dir = await fixture({ 'x.verify.json': `${JSON.stringify(FLOOR, null, 2)}\n` });
    const { data, lines, spawned } = await hop(dir, { unit: BELOW });
    // `spawned` holds exact labels, so `indexOf('x verify')` is the full run, never the unit-only one.
    expect(spawned).toContain('x verify --only unit');
    expect(spawned).toContain('x verify');
    expect(spawned.indexOf('x verify --only unit')).toBeLessThan(spawned.indexOf('x verify'));
    const written = await floorFile(dir);
    expect(written.steps).toEqual(FLOOR.steps);
    expect(written.coverage.lines).toBe(76);
    expect(written.coverage.funcs).toBe(63);
    expect(written.coverage.exclude).toEqual(FLOOR.coverage.exclude);
    expect(written.coverage.why).toStartWith('Rebaselined 2026-11-11 by x upgrade to 20.1.0: Bun');
    expect(written.coverage.why).toContain('63.3% of functions');
    expect(written.coverage.why).toEndWith(' page renders run in e2e only.');
    expect(lines.join('\n')).toContain(
      'coverage floor: x.verify.json 76 / 64 -> 76 / 63, measured 76.3% / 63.3%',
    );
    expect(data['coverage']).toEqual({
      file: 'x.verify.json',
      measured: { lines: 76.38, funcs: 63.31 },
      from: { lines: 76, funcs: 64 },
      to: { lines: 76, funcs: 63 },
      why: written.coverage.why,
    });
  });

  test('a measurement at or over the floor writes nothing', async () => {
    const text = `${JSON.stringify(FLOOR, null, 2)}\n`;
    const dir = await fixture({ 'x.verify.json': text });
    const { data } = await hop(dir, { unit: unitDocument({ lines: 77, funcs: 65 }, []) });
    expect(await Bun.file(join(dir, 'x.verify.json')).text()).toBe(text);
    expect(data['coverage']).toBeNull();
  });

  test('a red suite with no measurement writes nothing', async () => {
    const text = `${JSON.stringify(FLOOR, null, 2)}\n`;
    const dir = await fixture({ 'x.verify.json': text });
    const { data } = await hop(dir, { unit: unitDocument(undefined, ['X_TEST_FAILED']) });
    expect(await Bun.file(join(dir, 'x.verify.json')).text()).toBe(text);
    expect(data['coverage']).toBeNull();
  });

  test('a hop that leaves the Bun floor where it was measures nothing', async () => {
    const dir = await fixture({
      'x.verify.json': `${JSON.stringify(FLOOR, null, 2)}\n`,
      'package.json': `${JSON.stringify({
        name: 'app',
        engines: { bun: `>=${REQUIRED_BUN}` },
        dependencies: { '@ultimat3/cli': '^19.4.0' },
      })}\n`,
    });
    const { spawned } = await hop(dir, { unit: BELOW });
    expect(spawned).not.toContain('x verify --only unit');
    expect((await floorFile(dir)).coverage.funcs).toBe(64);
  });

  test('an app that states no coverage floor is not measured', async () => {
    const dir = await fixture();
    const { spawned } = await hop(dir, { unit: BELOW });
    expect(spawned).not.toContain('x verify --only unit');
  });
});
