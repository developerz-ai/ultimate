// The gate rule that keeps `CLAUDE.md`'s realtime capacity figures equal to the committed bench
// results. Every negative case is a FIXTURE — a fake claim over fake prose — never an edit to the
// real `CLAUDE.md` or to a result file, both of which the gate reads while this suite runs.

import { describe, expect, test } from 'bun:test';
// `node:` — Bun has no temporary-directory or path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BenchClaim,
  type BenchGap,
  benchClaimGaps,
  benchGapFindingFor,
  CLAIMS,
  CLAIMS_FILE,
  checkBenchClaims,
  groupDigits,
  RESULTS_10K,
  readNumber,
  renderBench,
} from './bench-claims';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const RESULTS = 'scripts/bench/results/fixture.json';

const claim: BenchClaim = {
  label: 'patches received',
  file: RESULTS,
  path: 'seq.received',
  format: 'count',
  pattern: /\*\*([\d,]+) patches received/,
};

const findings = (prose: string, received: unknown, claims: readonly BenchClaim[] = [claim]) =>
  checkBenchClaims({
    claims,
    prose,
    results: { [RESULTS]: { seq: { received } } },
  }).map(benchGapFindingFor);

const PROSE = 'all 10,000 reconnected: **1,666,882 patches received, 0 gaps**';

describe('unit · a figure the results no longer support', () => {
  test('is refused, and the fix carries the exact string to write', () => {
    const found = findings(PROSE, 1_666_883);

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_BENCH_CLAIM_STALE');
    expect(found[0]?.cause).toContain('1,666,882');
    expect(found[0]?.cause).toContain('1,666,883');
    expect(found[0]?.fix).toContain('write 1,666,883');
    expect(found[0]?.at).toBe(CLAIMS_FILE);
  });

  test('passes when prose and result agree', () => {
    expect(findings(PROSE, 1_666_882)).toEqual([]);
  });
});

describe('unit · the rule cannot stop checking silently', () => {
  test('a claim whose sentence was reworded away is a finding, not a pass', () => {
    const found = findings('the delivery run received a great many patches', 1_666_882);

    expect(found).toHaveLength(1);
    expect(found[0]?.cause).toContain('no sentence in CLAUDE.md states');
    // The measured value rides in the fix, so restoring the sentence needs no second lookup.
    expect(found[0]?.fix).toContain('1,666,882');
  });

  test('a results key that moved is a finding, not agreement with undefined', () => {
    const found = findings(PROSE, 'not a number');

    expect(found).toHaveLength(1);
    expect(found[0]?.cause).toContain('carries no number at seq.received');
    expect(found[0]?.at).toBe(RESULTS);
  });
});

describe('unit · the rounding convention', () => {
  test('a duration is (ms / 1000) to one decimal — 53951ms is the 54.0s the prose states', () => {
    expect(renderBench(53_951, 'seconds')).toBe('54.0');
    expect(renderBench(105_540, 'seconds')).toBe('105.5');
    expect(renderBench(145_681, 'seconds')).toBe('145.7');
  });

  test('a prose figure rounded the other way is refused', () => {
    const seconds: BenchClaim = {
      label: 'first-delivery p50',
      file: RESULTS,
      path: 'seq.received',
      format: 'seconds',
      pattern: /p50 ([\d.]+)s/,
    };
    // 53.951s truncated rather than rounded — the reading the convention exists to rule out.
    const found = checkBenchClaims({
      claims: [seconds],
      prose: 'p50 53.9s',
      results: { [RESULTS]: { seq: { received: 53_951 } } },
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('mismatch');
  });

  test('a count groups every three digits, with no ICU in the answer', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(1000)).toBe('1,000');
    expect(groupDigits(156_851)).toBe('156,851');
  });

  test('a plain figure is neither grouped nor scaled', () => {
    expect(renderBench(200, 'plain')).toBe('200');
  });
});

describe('unit · reading a result', () => {
  test('a dot path that runs off the object answers undefined rather than throwing', () => {
    expect(readNumber({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(readNumber({ a: { b: 1 } }, 'a.b.c')).toBeUndefined();
    expect(readNumber(undefined, 'a')).toBeUndefined();
  });
});

describe('unit · a file that is not there', () => {
  /**
   * The rule's own false green, in both directions. Each half used to suppress the WHOLE check:
   * a deleted results file returned `[]` before a single claim was read, and a deleted `CLAUDE.md`
   * did the same. Deleting the bench results is a state a re-run passes through, which is exactly
   * when the committed figures are least trustworthy.
   */
  const dir = async (files: Readonly<Record<string, string>>): Promise<string> => {
    // `node:` — Bun has no temporary-directory or path-join primitive of its own.
    const root = await mkdtemp(join(tmpdir(), 'ultimate-bench-absent-'));
    for (const [path, body] of Object.entries(files)) await Bun.write(join(root, path), body);
    return root;
  };

  test('a deleted results file is unmeasured, never agreement with undefined', async () => {
    const root = await dir({ 'CLAUDE.md': 'p50 54.0s / p90 105.5s / max 145.7s' });
    try {
      const gaps = await benchClaimGaps(root);
      expect(gaps.length).toBe(CLAIMS.length);
      expect(gaps.every((gap) => gap.kind === 'unmeasured')).toBe(true);
      expect(benchGapFindingFor(gaps[0] as BenchGap).cause).toContain('compared against nothing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a deleted CLAUDE.md is unstated — the results are still there to be described', async () => {
    const root = await dir({ [RESULTS_10K]: JSON.stringify({ seq: { received: 1_666_882 } }) });
    try {
      const gaps = await benchClaimGaps(root);
      expect(gaps.length).toBeGreaterThan(0);
      const patches = gaps.find((gap) => gap.claim.path === 'seq.received');
      expect(patches?.kind).toBe('unstated');
      // The measured value rides in the fix, so restoring the sentence needs no second lookup.
      expect(benchGapFindingFor(patches as BenchGap).fix).toContain('1,666,882');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('neither file is the one silence left, and it is about the TREE, not the rule', async () => {
    // A synthetic root in scripts/verify.test.ts makes no capacity claims and commits no bench.
    const root = await dir({ 'README.md': '# not this repo\n' });
    try {
      expect(await benchClaimGaps(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unit · this repo', () => {
  /**
   * The live rule, against the real tree. Unlike the publish list this one is GREEN today — the
   * figures and the committed results already agree — so asserting it here costs nothing and makes
   * the suite fail in the same commit that moves a number in either file.
   */
  test(
    'every figure CLAUDE.md states is the figure the committed bench results carry',
    async () => {
      expect(await benchClaimGaps(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('checks both committed runs, so neither can drift unwatched', () => {
    expect(new Set(CLAIMS.map((one) => one.file)).size).toBe(2);
    expect(CLAIMS.length).toBeGreaterThan(9);
  });
});
