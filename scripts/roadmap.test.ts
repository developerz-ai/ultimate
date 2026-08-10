import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import {
  checkRoadmap,
  MILESTONE_NUMBERS,
  milestoneRow,
  REQUIRED_ARTIFACTS,
  ROADMAP_FILE,
  STATUS_MARK,
} from './roadmap';

const TABLE_HEAD = '| # | Status | Milestone | Ships | Done when |\n|---|---|---|---|---|\n';

/** A roadmap whose every milestone row carries `mark`, so a test can vary one row at a time. */
const roadmapWith = (rows: Readonly<Record<number, string>>): string =>
  TABLE_HEAD +
  MILESTONE_NUMBERS.map((n) => `| ${n} | ${rows[n] ?? ''} | **m${n}** | ships | done |`).join('\n');

async function inTempRepo(
  markdown: string | undefined,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-roadmap-'));
  try {
    if (markdown !== undefined) await Bun.write(join(dir, ROADMAP_FILE), markdown);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('unit · the roadmap table is the gate', () => {
  test('this repo passes its own roadmap check', async () => {
    expect(await checkRoadmap(repoRoot())).toEqual([]);
  });

  test('a deleted roadmap is a finding, not a silent pass', async () => {
    await inTempRepo(undefined, async (dir) => {
      const findings = await checkRoadmap(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_ROADMAP_FILE_MISSING');
      expect(findings[0]?.at).toBe(ROADMAP_FILE);
      expect(findings[0]?.fix).toBe(`git checkout -- ${ROADMAP_FILE}`);
    });
  });

  test('a milestone marked shipped with a missing artifact is caught', async () => {
    await inTempRepo(roadmapWith({ 0: STATUS_MARK.shipped }), async (dir) => {
      const findings = await checkRoadmap(dir);
      const codes = findings.map((finding) => finding.code);
      expect(codes).toContain('X_ROADMAP_MILESTONE_UNVERIFIED');
      // Every other row is blank, so each one is also missing its marker.
      expect(codes).toContain('X_ROADMAP_STATUS_MISSING');
      const unverified = findings.find(
        (finding) => finding.code === 'X_ROADMAP_MILESTONE_UNVERIFIED',
      );
      expect(unverified?.cause).toContain('milestone 0 ("m0")');
      expect(unverified?.fix).toStartWith('git checkout -- packages/core/src/index.ts');
    });
  });

  test('a milestone row with no status marker is caught', async () => {
    await inTempRepo(roadmapWith({}), async (dir) => {
      const findings = await checkRoadmap(dir);
      expect(findings).toHaveLength(MILESTONE_NUMBERS.length);
      expect(findings[0]?.code).toBe('X_ROADMAP_STATUS_MISSING');
      expect(findings[0]?.cause).toContain('milestone 0');
      expect(findings[0]?.fix).toContain('| 0 |');
    });
  });

  test('a milestone with no row at all is caught the same way', async () => {
    await inTempRepo(
      `${TABLE_HEAD}| 0 | ${STATUS_MARK['in-progress']} | **m0** | s | d |`,
      async (dir) => {
        const codes = (await checkRoadmap(dir)).map((finding) => finding.code);
        expect(codes).toEqual(MILESTONE_NUMBERS.slice(1).map(() => 'X_ROADMAP_STATUS_MISSING'));
      },
    );
  });

  test('an in-progress milestone is not held to its artifacts', async () => {
    const marks = Object.fromEntries(MILESTONE_NUMBERS.map((n) => [n, STATUS_MARK['in-progress']]));
    await inTempRepo(roadmapWith(marks), async (dir) => {
      expect(await checkRoadmap(dir)).toEqual([]);
    });
  });
});

describe('unit · status and title are read from the table, never mirrored', () => {
  test('the marker in the row decides the status', () => {
    const markdown = roadmapWith({ 0: STATUS_MARK.shipped, 1: STATUS_MARK['in-progress'] });
    expect(milestoneRow(markdown, 0)).toEqual({ n: 0, status: 'shipped', title: 'm0' });
    expect(milestoneRow(markdown, 1)).toEqual({ n: 1, status: 'in-progress', title: 'm1' });
  });

  test('a row with no marker, and an absent row, are both undefined', () => {
    expect(milestoneRow(roadmapWith({}), 0)).toBeUndefined();
    expect(milestoneRow(TABLE_HEAD, 0)).toBeUndefined();
  });

  test('the title is read without its markdown emphasis', () => {
    const markdown = `${TABLE_HEAD}| 3 | ${STATUS_MARK.shipped} | **Rendering + router** | s | d |`;
    expect(milestoneRow(markdown, 3)?.title).toBe('Rendering + router');
  });

  test('flipping the real table to in-progress flips the status, with no code change', async () => {
    const real = await Bun.file(join(repoRoot(), ROADMAP_FILE)).text();
    expect(milestoneRow(real, 0)?.status).toBe('shipped');
    const flipped = real.replace(
      `| 0 | ${STATUS_MARK.shipped} |`,
      `| 0 | ${STATUS_MARK['in-progress']} |`,
    );
    expect(milestoneRow(flipped, 0)?.status).toBe('in-progress');
  });

  test('every milestone the table names has an artifact list, and the reverse', async () => {
    const real = await Bun.file(join(repoRoot(), ROADMAP_FILE)).text();
    for (const n of MILESTONE_NUMBERS) {
      expect(milestoneRow(real, n)).toBeDefined();
      expect(REQUIRED_ARTIFACTS[n]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
