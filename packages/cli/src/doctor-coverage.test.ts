import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { coverageExcludesProbe, withCoverageExcludes } from './doctor-coverage';
import { msg } from './messages';
import type { CommandResult } from './output';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const CLEAN: CommandResult = {
  ok: true,
  command: 'doctor',
  summary: 'no findings',
  findings: [],
  data: { count: 0 },
  lines: ['an earlier line'],
};

const EXCLUDE = [
  { glob: 'apps/**/*.island.tsx', why: 'browser-only mount' },
  { glob: 'apps/*/server.ts', why: 'container entry point' },
];

describe('x doctor prints what the coverage floor does not see', () => {
  test('each exclude beside its reason, for a person and for a machine — and the verdict untouched', () => {
    const result = withCoverageExcludes(CLEAN, EXCLUDE);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(CLEAN.summary);
    expect(result.data).toEqual({ count: 0, coverage: { exclude: EXCLUDE } });
    expect(result.lines).toEqual([
      'an earlier line',
      msg('cli.doctor.coverageExclude', { count: 2 }),
      '  apps/**/*.island.tsx — browser-only mount',
      '  apps/*/server.ts — container entry point',
    ]);
    expect(msg('cli.doctor.coverageExclude', { count: 2 })).not.toContain('⟦');
  });

  test('nothing excluded prints nothing, and says so in data', () => {
    const result = withCoverageExcludes({ ...CLEAN, data: 'not an object' }, []);
    expect(result.lines).toEqual(['an earlier line']);
    expect(result.data).toEqual({ coverage: { exclude: [] } });
  });

  test('the probe reads x.verify.json: its excludes, and none where no floor is stated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-doctor-coverage-'));
    try {
      expect(await coverageExcludesProbe(root)).toEqual([]);
      await Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps: [] }));
      expect(await coverageExcludesProbe(root)).toEqual([]);
      await Bun.write(
        join(root, VERIFY_FLOOR_FILE),
        JSON.stringify({ steps: [], coverage: { lines: 95, funcs: 95, exclude: EXCLUDE } }),
      );
      expect(await coverageExcludesProbe(root)).toEqual(EXCLUDE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
