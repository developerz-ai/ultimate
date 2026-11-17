// The committed shard weights: the writer keeps only what a part measured itself, the file on disk
// is the writer's canonical output, ci.yml's shards read it, and weighted shards still merge as one
// corpus exactly once.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { mergeParts } from '../../../packages/cli/src/verify-merge';
import { shardFiles } from '../../../packages/cli/src/verify-shard';
import { jobOf, readWorkflow, text } from '../ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from '../run';
import {
  freshWeights,
  type MeasuredPart,
  parseWeights,
  predictedLoads,
  readMeasuredParts,
  renderWeights,
  WEIGHTS_FILE,
} from './test-weights';

// Reads the real tree (the committed weights, ci.yml), so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const measured = (
  part: string,
  attempt: number,
  ran: readonly string[],
  timings: Record<string, number>,
): MeasuredPart => ({ part, attempt, ran: { unit: ran }, timings });

describe('unit · test weights · the writer keeps what each part measured itself', () => {
  test('a part`s restored cache entries are dropped; only the files it ran count', () => {
    // unit-1 restored b's stale 9999 from the cache; unit-2 ran b and measured 20.
    const weights = freshWeights([
      measured('unit-1', 1, ['a.test.ts'], { 'a.test.ts': 10.4, 'b.test.ts': 9999 }),
      measured('unit-2', 1, ['b.test.ts'], { 'a.test.ts': 1, 'b.test.ts': 20 }),
    ]);
    expect(weights).toEqual({ 'a.test.ts': 10, 'b.test.ts': 20 });
  });

  test('the newest attempt of a part wins, whatever order the artifacts were read in', () => {
    const old = measured('unit-1', 1, ['a.test.ts'], { 'a.test.ts': 100 });
    const rerun = measured('unit-1', 2, ['a.test.ts'], { 'a.test.ts': 40 });
    expect(freshWeights([rerun, old])).toEqual({ 'a.test.ts': 40 });
    expect(freshWeights([old, rerun])).toEqual({ 'a.test.ts': 40 });
  });

  test('a file a part ran but Bun never timed, or timed as junk, is left out — never 0', () => {
    const weights = freshWeights([
      measured('unit-1', 1, ['a.test.ts', 'b.test.ts', 'c.test.ts'], {
        'a.test.ts': 5,
        'c.test.ts': Number.NaN,
      }),
    ]);
    expect(weights).toEqual({ 'a.test.ts': 5 });
  });

  test('the rendered file is canonical: sorted keys, integer ms, one trailing newline', () => {
    const doc = {
      measuredAt: '2026-11-16T00:00:00.000Z',
      source: 'ci run 1',
      files: { b: 2, a: 1 },
    };
    const rendered = renderWeights(doc);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(rendered).files)).toEqual(['a', 'b']);
    expect(parseWeights(JSON.parse(rendered))).toEqual(doc);
  });

  test('a document that is not the shape is refused with the reason, never read as empty', () => {
    expect(parseWeights([])).toBeTypeOf('string');
    expect(parseWeights({ measuredAt: 'x', source: 's', files: { a: 1 } })).toContain('measuredAt');
    expect(
      parseWeights({ measuredAt: '2026-11-16T00:00:00.000Z', source: '', files: {} }),
    ).toContain('source');
    expect(
      parseWeights({ measuredAt: '2026-11-16T00:00:00.000Z', source: 's', files: { a: 1.5 } }),
    ).toContain('a');
  });
});

describe('unit · test weights · a downloaded CI run, read', () => {
  test('each timings artifact pairs with its part`s document, by part and attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-weights-'));
    try {
      const write = async (path: string, value: unknown) => {
        await mkdir(join(dir, path, '..'), { recursive: true });
        await Bun.write(join(dir, path), JSON.stringify(value));
      };
      const doc = (files: readonly string[]) => ({
        steps: [{ name: 'unit', shard: { index: 1, total: 2, corpusHash: 'h', files } }],
      });
      await write('verify-part-unit-1-attempt-1/unit-1.attempt-1.json', doc(['a.test.ts']));
      await write('test-timings-unit-1-attempt-1/test-timings.json', {
        version: 1,
        files: { 'a.test.ts': 7, 'b.test.ts': 3 },
      });
      // A timings artifact with no document cannot say which entries are fresh: skipped.
      await write('test-timings-unit-2-attempt-1/test-timings.json', { files: { 'b.test.ts': 9 } });
      const read = await readMeasuredParts(dir);
      expect(read.parts).toEqual([
        measured('unit-1', 1, ['a.test.ts'], { 'a.test.ts': 7, 'b.test.ts': 3 }),
      ]);
      expect(read.unpaired).toEqual(['test-timings-unit-2-attempt-1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('unit · test weights · the committed file and ci.yml', () => {
  const root = repoRoot();

  test(`${WEIGHTS_FILE} is the writer's own output: parseable, canonical, never hand-edited`, async () => {
    const raw = await Bun.file(join(root, WEIGHTS_FILE)).text();
    const parsed = parseWeights(JSON.parse(raw));
    if (typeof parsed === 'string') return expect.unreachable(parsed);
    expect(Object.keys(parsed.files).length).toBeGreaterThan(1000);
    expect(raw).toBe(renderWeights(parsed));
  });

  test('every gate shard splits on the committed weights, and its step title says so', async () => {
    const gate = jobOf(await readWorkflow('ci.yml'), 'gate');
    const run = (gate.steps ?? []).find((step) =>
      text(step.run).includes('scripts/verify.ts --only'),
    );
    expect(text(run?.run)).toContain(`\${SHARD:+--shard "$SHARD" --timings ${WEIGHTS_FILE}}`);
    expect(text(run?.name)).toContain(`--timings ${WEIGHTS_FILE}`);
  });
});

describe('unit · test weights · weighted shards are still one corpus exactly once', () => {
  const FILES = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'new.test.ts'];
  const WEIGHTS = { 'a.test.ts': 90, 'b.test.ts': 50, 'c.test.ts': 40, 'd.test.ts': 30 };
  const slice = (index: number, weights?: Record<string, number>) => ({
    file: `unit-${String(index)}.json`,
    durationMs: 1,
    steps: [
      {
        name: 'unit',
        ok: true,
        durationMs: 1,
        skipped: false,
        findings: [],
        tests: { ran: 1, skipped: 0 },
        shard: shardFiles(FILES, { index, total: 3 }, weights),
      },
    ],
  });

  test('three weighted parts merge green', () => {
    const result = mergeParts(
      [1, 2, 3].map((i) => slice(i, WEIGHTS)),
      undefined,
      ['unit'],
    );
    expect(result.ok).toBe(true);
  });

  test('one part split without the weights is red: a file ran twice or nowhere', () => {
    const result = mergeParts([slice(1, WEIGHTS), slice(2), slice(3, WEIGHTS)], undefined, [
      'unit',
    ]);
    expect(result.ok).toBe(false);
  });

  test('the predicted loads are what shardFiles deals, costed by the weights and the median', () => {
    // The dealer's own answer, summed: a file the weights do not know costs their median, 50.
    const loads = predictedLoads({ unit: FILES }, WEIGHTS, 3, true);
    const dealt = [1, 2, 3].map((index) =>
      shardFiles(FILES, { index, total: 3 }, WEIGHTS).files.reduce(
        (sum, file) => sum + ((WEIGHTS as Record<string, number>)[file] ?? 50),
        0,
      ),
    );
    expect(loads).toEqual(dealt);
    expect(predictedLoads({ unit: FILES }, WEIGHTS, 3, false)).toEqual([120, 100, 90]);
  });
});
