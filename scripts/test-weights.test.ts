// `scripts/test-weights.ts`, run: a downloaded CI run becomes the canonical weights file plus the
// loads it predicts, and a directory holding no measured part is refused, never an empty file.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { parseWeights, renderWeights } from './lib/ci/test-weights';

const SCRIPT = join(import.meta.dir, 'test-weights.ts');

const run = async (args: readonly string[]) => {
  const child = Bun.spawn(['bun', SCRIPT, ...args, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, doc: JSON.parse(stdout) as Record<string, unknown> };
};

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'test-weights-run-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('unit · scripts/test-weights.ts', () => {
  test('two parts` artifacts: each keeps what it ran, written canonical, loads predicted', () =>
    withDir(async (dir) => {
      const part = async (name: string, files: readonly string[], ms: Record<string, number>) => {
        await mkdir(join(dir, `verify-part-${name}-attempt-1`), { recursive: true });
        await Bun.write(
          join(dir, `verify-part-${name}-attempt-1`, `${name}.attempt-1.json`),
          JSON.stringify({ steps: [{ name: 'unit', shard: { files } }] }),
        );
        await mkdir(join(dir, `test-timings-${name}-attempt-1`), { recursive: true });
        await Bun.write(
          join(dir, `test-timings-${name}-attempt-1`, 'test-timings.json'),
          JSON.stringify({ version: 1, files: ms }),
        );
      };
      await part('unit-1', ['a.test.ts'], { 'a.test.ts': 4000, 'b.test.ts': 1 });
      await part('unit-2', ['b.test.ts', 'c.test.ts'], { 'b.test.ts': 8000, 'c.test.ts': 4000 });
      const out = join(dir, 'weights.json');
      const { code, doc } = await run([dir, '--out', out]);
      expect(code).toBe(0);
      const raw = await Bun.file(out).text();
      const weights = parseWeights(JSON.parse(raw));
      if (typeof weights === 'string') return expect.unreachable(weights);
      expect(weights.files).toEqual({ 'a.test.ts': 4000, 'b.test.ts': 8000, 'c.test.ts': 4000 });
      expect(raw).toBe(renderWeights(weights));
      // Two shards: round-robin deals a+c | b = 2 s | 2 s at four workers; weighted, b | a+c too.
      expect((doc['data'] as { predicted: unknown }).predicted).toEqual([
        { shards: 2, roundRobinSeconds: [2, 2], weightedSeconds: [2, 2] },
        { shards: 3, roundRobinSeconds: [1, 2, 1], weightedSeconds: [2, 1, 1] },
      ]);
    }));

  test('a directory with no paired part is X_CORPUS_UNSCANNED, and nothing is written', () =>
    withDir(async (dir) => {
      await mkdir(join(dir, 'test-timings-unit-1-attempt-1'), { recursive: true });
      await Bun.write(join(dir, 'test-timings-unit-1-attempt-1', 'test-timings.json'), '{}');
      const out = join(dir, 'weights.json');
      const { code, doc } = await run([dir, '--out', out]);
      expect(code).toBe(1);
      const [finding] = doc['findings'] as { code: string; cause: string }[];
      expect(finding?.code).toBe('X_CORPUS_UNSCANNED');
      expect(finding?.cause).toContain('test-timings-unit-1-attempt-1');
      expect(await Bun.file(out).exists()).toBe(false);
    }));
});
