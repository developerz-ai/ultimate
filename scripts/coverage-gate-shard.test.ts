// The gate's scheduling half, driven directly: how `--shard i/n` deals the units, and which
// flags the gate reads. Split from `coverage-gate.test.ts` (its verdict half) at the file ceiling.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the unloaded-file fixture is a real tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { unitWeight } from './lib/coverage-schedule';
import {
  COVERAGE_GATE_FLAGS,
  scheduledNames,
  scheduledWeight,
  shardUnits,
  testFileCount,
  unitOf,
  unitsFor,
  unitsToGate,
} from './lib/coverage-units';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('--shard i/n', () => {
  const units = unitsToGate(repoRoot());

  for (const total of [2, 3]) {
    test(`every unit is in exactly one shard of ${String(total)}`, () => {
      const shards = Array.from({ length: total }, (_, i) =>
        shardUnits(units, `${String(i + 1)}/${String(total)}`),
      );
      expect(shards.flat().sort()).toEqual([...units]);
      expect(new Set(shards.flat()).size).toBe(units.length);
      // Round-robin: no shard is more than one unit larger than another.
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });
  }

  test('round-robin over the SORTED list, whatever order it arrives in', () => {
    expect(shardUnits(['c', 'a', 'd', 'b'], '1/2')).toEqual(['a', 'c']);
    expect(shardUnits(['c', 'a', 'd', 'b'], '2/2')).toEqual(['b', 'd']);
  });

  test('weighed, the heaviest unit is dealt first and the rest fill the lighter shards', () => {
    // `cli` alone outweighs the rest together: it keeps a shard to itself, and the others are
    // dealt between the remaining two by weight, never by name.
    const weight = (name: string): number =>
      ({ cli: 660, scripts: 240, core: 180, jobs: 170, db: 160, money: 10 })[name] ?? 1;
    const units = ['money', 'db', 'cli', 'core', 'jobs', 'scripts'];
    expect(shardUnits(units, '1/3', weight)).toEqual(['cli']);
    expect(shardUnits(units, '2/3', weight)).toEqual(['db', 'scripts']);
    expect(shardUnits(units, '3/3', weight)).toEqual(['core', 'jobs', 'money']);
  });

  test('the real tree, weighed by measured core-seconds: every unit in exactly one shard', () => {
    const weigh = (name: string): number => unitWeight(name);
    const shards = [1, 2].map((i) => shardUnits(units, `${String(i)}/2`, weigh));
    expect(shards.flat().sort()).toEqual([...units]);
    expect(new Set(shards.flat()).size).toBe(units.length);
    // The weights are real: `cli` is the heaviest unit, dealt first to shard 1, and the rest are
    // dealt so neither shard carries more than the other plus the lightest-dealt unit.
    expect(shards[0]?.includes('cli')).toBe(true);
    const load = (shard: readonly string[] | undefined): number =>
      (shard ?? []).reduce((sum, name) => sum + weigh(name), 0);
    expect(Math.abs(load(shards[0]) - load(shards[1]))).toBeLessThanOrEqual(weigh('cli'));
  });

  test('a test file is counted where bun test finds one: *.test and *.spec, never node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coverage-weight-'));
    try {
      for (const rel of [
        'packages/w/src/a.test.ts',
        'packages/w/e2e/b.spec.tsx',
        'packages/w/src/c.ts',
        'packages/w/node_modules/dep/d.test.ts',
        'packages/other/src/e.test.ts',
      ]) {
        await Bun.write(join(root, rel), 'export {};\n');
      }
      expect(testFileCount(root, unitOf('w'))).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a spec that is not i/n with 1 <= i <= n is refused with a command that runs', () => {
    for (const raw of ['0/2', '3/2', '1', 'a/b', '', '1/0']) {
      try {
        shardUnits(units, raw);
        expect.unreachable(`"${raw}" was accepted`);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'X_CLI_BAD_FLAG',
          fix: 'bun run scripts/coverage-gate.ts --all --shard 1/2',
        });
      }
    }
  });
});

describe('the flags the gate reads', () => {
  const root = repoRoot();
  const flags = (
    entries: Record<string, string | boolean>,
  ): ReadonlyMap<string, string | boolean> => new Map(Object.entries(entries));
  const refusal = (entries: Record<string, string | boolean>): unknown => {
    try {
      unitsFor(root, flags(entries));
    } catch (error) {
      return error;
    }
    return expect.unreachable(`${JSON.stringify(entries)} was accepted`);
  };

  test('--package names one unit, --all every one, --all --shard a share', () => {
    expect(unitsFor(root, flags({ package: 'core', json: true }))).toEqual(['core']);
    const all = unitsFor(root, flags({ all: true }));
    expect(all).toEqual(scheduledNames(root, unitsToGate(root)));
    expect(unitsFor(root, flags({ all: true, shard: '2/2', jobs: '2' }))).toEqual(
      shardUnits(all, '2/2', scheduledWeight),
    );
  });

  test('a unit too heavy for one runner is scheduled as its parts, never whole', () => {
    // `cli` is the one today (`PART_MS`): `--package cli` runs every part, `--all` deals them.
    const parts = unitsFor(root, flags({ package: 'cli' }));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts).toEqual(parts.map((_, at) => `cli#${String(at + 1)}/${String(parts.length)}`));
    const all = unitsFor(root, flags({ all: true }));
    expect(all).not.toContain('cli');
    for (const part of parts) expect(all).toContain(part);
    // A part weighs its share of the unit, so the shards stay balanced on core-seconds.
    expect(scheduledWeight('cli#1/2')).toBe(unitWeight('cli') / 2);
    expect(scheduledWeight('core')).toBe(unitWeight('core'));
  });

  test('--merge <dir> folds the cut units alone, and refuses to run a suite beside it', () => {
    expect(unitsFor(root, flags({ merge: '.x/coverage-parts' }))).toEqual(['cli']);
    for (const entries of [
      { merge: true },
      { merge: 'd', all: true },
      { merge: 'd', package: 'cli' },
    ]) {
      const refused = refusal(entries) as { code: string; fix: string };
      expect(refused.code).toBe('X_CLI_BAD_FLAG');
      expect(refused.fix).toBe('bun run scripts/coverage-gate.ts --merge .x/coverage-parts');
    }
  });

  test('--all given a value is refused, never read as off', () => {
    const refused = refusal({ all: 'false' }) as { code: string; cause: string; fix: string };
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain('--all takes no value');
    expect(refused.fix).toBe('bun run scripts/coverage-gate.ts --all');
  });

  test('an unknown flag is refused, never dropped', () => {
    expect(COVERAGE_GATE_FLAGS).toContain('shard');
    expect(refusal({ all: true, shrad: '1/2' })).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'bun run scripts/coverage-gate.ts --all',
    });
  });

  test('--shard without --all, neither flag, both flags and a bare --shard are refused', () => {
    expect(refusal({ package: 'core', shard: '1/2' })).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'bun run scripts/coverage-gate.ts --all --shard 1/2',
    });
    expect(refusal({})).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ package: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ package: 'core', all: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ all: true, shard: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
  });
});
