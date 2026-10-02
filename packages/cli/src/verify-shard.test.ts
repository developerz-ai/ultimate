// `x verify --shard i/n`: refusals first, then the split's two promises — deterministic, and n
// shards are the corpus exactly once.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { readShard } from './cmd-verify';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by';
import { assertShardable, corpusHash, parseShard, readTimings, shardFiles } from './verify-shard';

const corpus = Array.from({ length: 23 }, (_, i) => `pkg/f${String(i).padStart(2, '0')}.test.ts`);

describe('unit · --shard refusals', () => {
  test('a spec that is not i/n, or names a shard outside 1..n, is X_VERIFY_SHARD_INVALID', () => {
    for (const raw of ['3', '0/4', '5/4', 'a/b', '1/0', '-1/3', '']) {
      expect(thrownBy(() => parseShard(raw)).code).toBe('X_VERIFY_SHARD_INVALID');
    }
    expect(thrownBy(() => parseShard('5/4')).fix).toContain('--shard 4/4');
  });

  test('every refusal is spelled for the entry that raised it', () => {
    // The codes are shipped; only the command the fix names follows the caller.
    const root = 'bun run verify';
    expect(thrownBy(() => parseShard('x', root)).fix).toBe(
      'bun run verify --only unit --shard 1/4 --json',
    );
    expect(thrownBy(() => parseShard('x', root)).cause).toStartWith('bun run verify --shard: ');
    expect(thrownBy(() => parseShard('5/4', root)).fix).toBe(
      'bun run verify --only unit --shard 4/4 --json',
    );
    expect(thrownBy(() => assertShardable(undefined, root)).fix).toBe(
      'bun run verify --only unit --shard 1/4 --json',
    );
    expect(thrownBy(() => assertShardable(['unit', 'live'], root)).fix).toBe(
      'bun run verify --only unit --shard 1/4 --json',
    );
    expect(thrownBy(() => assertShardable(['live'], root)).fix).toBe(
      'bun run verify --only live --json',
    );
    // And an app, which passes nothing, still reads `x verify`.
    expect(thrownBy(() => parseShard('x')).fix).toBe('x verify --only unit --shard 1/4 --json');
    expect(thrownBy(() => assertShardable(['live'])).fix).toBe('x verify --only live --json');
  });

  test('a shard without --only, or over a serial step, is refused naming the step', () => {
    expect(thrownBy(() => assertShardable(undefined)).code).toBe('X_VERIFY_SHARD_INVALID');
    const serial = thrownBy(() => assertShardable(['unit', 'live']));
    expect(serial.code).toBe('X_VERIFY_SHARD_INVALID');
    expect(serial.cause).toContain('live cannot be split');
    expect(serial.fix).toBe('x verify --only unit --shard 1/4 --json');
    expect(thrownBy(() => assertShardable(['e2e'])).fix).toBe('x verify --only e2e --json');
    expect(() => assertShardable(['unit', 'contract', 'job'])).not.toThrow();
  });

  test('the command refuses before anything runs: --timings alone, --shard without --only', async () => {
    const args = (argv: string[]) => parseArgs(['verify', ...argv], SPECS);
    const noShard = await readShard(args(['--timings', 't.json']), undefined).catch((e) => e);
    expect(noShard.code).toBe('X_VERIFY_SHARD_INVALID');
    const noOnly = await readShard(args(['--shard', '1/2']), undefined).catch((e) => e);
    expect(noOnly.code).toBe('X_VERIFY_SHARD_INVALID');
    expect(await readShard(args(['--shard', '2/3']), ['unit'])).toEqual({ index: 2, total: 3 });
  });

  test('a timings file that is missing or not an object is refused, never ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-timings-'));
    try {
      expect((await readTimings(join(dir, 'nope.json')).catch((e) => e)).code).toBe(
        'X_VERIFY_SHARD_INVALID',
      );
      writeFileSync(join(dir, 'bad.json'), '[1,2]');
      expect((await readTimings(join(dir, 'bad.json')).catch((e) => e)).code).toBe(
        'X_VERIFY_SHARD_INVALID',
      );
      writeFileSync(join(dir, 'ok.json'), '{"a.test.ts": 12}');
      expect(await readTimings(join(dir, 'ok.json'))).toEqual({ 'a.test.ts': 12 });
      // Bun's own --update-timings shape.
      writeFileSync(join(dir, 'bun.json'), '{"version":1,"files":{"a.test.ts": 7}}');
      expect(await readTimings(join(dir, 'bun.json'))).toEqual({ 'a.test.ts': 7 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unit · the split', () => {
  test('n shards cover the corpus exactly once, round-robin over the sorted list', () => {
    const shards = [1, 2, 3, 4].map((index) => shardFiles(corpus, { index, total: 4 }));
    const all = shards.flatMap((shard) => shard.files);
    expect(all.sort()).toEqual([...corpus].sort());
    expect(new Set(all).size).toBe(corpus.length);
    expect(shards[0]?.files.slice(0, 2)).toEqual(['pkg/f00.test.ts', 'pkg/f04.test.ts']);
    // Sizes differ by at most one.
    const sizes = shards.map((shard) => shard.files.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test('discovery order cannot move a file, and every shard carries the same corpus hash', () => {
    const reversed = shardFiles([...corpus].reverse(), { index: 2, total: 3 });
    const sorted = shardFiles(corpus, { index: 2, total: 3 });
    expect(reversed).toEqual(sorted);
    expect(sorted.corpusHash).toBe(corpusHash(corpus));
    expect(shardFiles(corpus.slice(1), { index: 2, total: 3 }).corpusHash).not.toBe(
      sorted.corpusHash,
    );
  });

  test('more shards than files leaves some empty, never an error', () => {
    const shards = [1, 2, 3].map((index) => shardFiles(['a.test.ts'], { index, total: 3 }));
    expect(shards.map((shard) => shard.files.length)).toEqual([1, 0, 0]);
  });

  test('with timings: greedy longest-first balances the load, unknown files cost the median', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'new'];
    const timings = { a: 100, b: 60, c: 50, d: 30, e: 10 };
    const shards = [1, 2].map((index) => shardFiles(files, { index, total: 2 }, timings));
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort());
    const load = (list: readonly string[]) =>
      list.reduce((sum, file) => sum + ((timings as Record<string, number>)[file] ?? 50), 0);
    const loads = shards.map((shard) => load(shard.files));
    // 100 alone on one side; 60+50+30+10+50(new, the median) on the other would be 200 — greedy
    // gets within the largest item of perfect.
    expect(Math.abs((loads[0] as number) - (loads[1] as number))).toBeLessThanOrEqual(100);
    expect(shards[0]?.files).toContain('a');
  });
});
