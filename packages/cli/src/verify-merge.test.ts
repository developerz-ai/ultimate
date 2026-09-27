// `x verify merge`: n CI parts → one gate verdict. Every gap is a named finding, never a pass.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { verifyCommand } from './cmd-verify';
import { renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by';
import type { VerifyPart } from './verify-merge';
import { mergeParts, parsePart } from './verify-merge';
import { shardFiles } from './verify-shard';

const DECLARED = ['lint', 'unit', 'live'];
const FILES = ['a.test.ts', 'b.test.ts', 'c.test.ts'];

const unitShard = (index: number, total: number, ran: number, files = FILES) => ({
  name: 'unit',
  ok: true,
  durationMs: 10 * index,
  skipped: false,
  findings: [],
  tests: { ran, skipped: 0 },
  shard: shardFiles(files, { index, total }),
});

const whole = (name: string, ok = true) => ({
  name,
  ok,
  durationMs: 5,
  skipped: false,
  findings: ok ? [] : [{ code: 'X_LINT', cause: 'bad', fix: 'x fix' }],
});

const part = (file: string, steps: VerifyPart['steps'], durationMs = 100): VerifyPart => ({
  file,
  durationMs,
  steps,
});

const codes = (result: ReturnType<typeof mergeParts>): string[] =>
  (result.steps ?? []).flatMap((step) => step.findings.map((finding) => finding.code));

describe('unit · x verify merge refuses an incomplete gate', () => {
  test('a missing shard is named, and the verdict is red', () => {
    const result = mergeParts(
      [
        part('static.json', [whole('lint'), whole('live')]),
        part('u1.json', [unitShard(1, 3, 4)]),
        part('u3.json', [unitShard(3, 3, 2)]),
      ],
      undefined,
      DECLARED,
    );
    expect(result.ok).toBe(false);
    const unit = result.steps?.find((step) => step.name === 'unit');
    expect(unit?.findings.map((f) => f.cause)).toContain('step "unit" is missing shard(s) 2/3');
    expect(result.exitCode).toBe(1);
  });

  test('a step no part ran is named', () => {
    const result = mergeParts(
      [part('only-lint.json', [whole('lint')]), part('u.json', [unitShard(1, 1, 3)])],
      undefined,
      DECLARED,
    );
    expect(result.ok).toBe(false);
    expect(result.steps?.find((s) => s.name === 'live')?.findings[0]?.cause).toBe(
      'step "live" is in no part — no CI job ran it',
    );
  });

  test('shards of two different corpora, or a shard twice, are refused', () => {
    const drifted = mergeParts(
      [
        part('s.json', [whole('lint'), whole('live')]),
        part('u1.json', [unitShard(1, 2, 2)]),
        part('u2.json', [unitShard(2, 2, 1, [...FILES, 'd.test.ts'])]),
      ],
      undefined,
      DECLARED,
    );
    expect(drifted.ok).toBe(false);
    expect(codes(drifted)).toContain('X_VERIFY_MERGE_INCOMPLETE');
    const doubled = mergeParts(
      [
        part('s.json', [whole('lint'), whole('live')]),
        part('u1.json', [unitShard(1, 2, 2)]),
        part('u1b.json', [unitShard(1, 2, 2)]),
        part('u2.json', [unitShard(2, 2, 1)]),
      ],
      undefined,
      DECLARED,
    );
    expect(doubled.ok).toBe(false);
    expect(doubled.steps?.find((s) => s.name === 'unit')?.findings[0]?.cause).toContain(
      'shard(s) 1 more than once',
    );
  });

  test('the zero-tests floor applies to the SUMMED counts the shards deferred', () => {
    const parts = [
      part('s.json', [whole('lint'), whole('live')]),
      part('u1.json', [unitShard(1, 2, 0)]),
      part('u2.json', [unitShard(2, 2, 0)]),
    ];
    const floored = mergeParts(parts, { steps: ['unit'], problems: [] }, DECLARED);
    expect(floored.ok).toBe(false);
    expect(codes(floored)).toContain('X_VERIFY_SUITE_VANISHED');
    // No floor: a split suite that ran nothing is a skip, not a pass.
    const bare = mergeParts(parts, undefined, DECLARED);
    expect(bare.ok).toBe(true);
    expect(bare.steps?.find((s) => s.name === 'unit')?.skipped).toBe(true);
  });

  test('a red step in any part is red in the merge, with its findings kept', () => {
    const result = mergeParts(
      [part('s.json', [whole('lint', false), whole('live')]), part('u.json', [unitShard(1, 1, 3)])],
      undefined,
      DECLARED,
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_LINT']);
  });
});

describe('unit · x verify merge — the green path', () => {
  test('every step once, every shard once: a gate verdict, summed counts, no notAGateRun', () => {
    const result = mergeParts(
      [
        part('s.json', [whole('lint'), whole('live')], 50),
        part('u1.json', [unitShard(1, 2, 4)], 120),
        part('u2.json', [unitShard(2, 2, 3)], 90),
      ],
      undefined,
      DECLARED,
    );
    expect(result.ok).toBe(true);
    expect(result.steps?.map((s) => s.name)).toEqual(DECLARED);
    expect(result.steps?.find((s) => s.name === 'unit')?.tests).toEqual({ ran: 7, skipped: 0 });
    const data = result.data as Record<string, unknown>;
    expect(data['notAGateRun']).toBeUndefined();
    expect(data['durationMs']).toBe(120);
    expect(result.summary).toContain('merged 3 part(s)');
  });
});

describe('unit · reading a part', () => {
  test('anything but an x verify --json document is X_VERIFY_MERGE_INPUT, naming the file', () => {
    expect(thrownBy(() => parsePart('a.json', '')).code).toBe('X_VERIFY_MERGE_INPUT');
    expect(thrownBy(() => parsePart('a.json', 'not json')).code).toBe('X_VERIFY_MERGE_INPUT');
    expect(thrownBy(() => parsePart('a.json', '{"command":"build"}')).code).toBe(
      'X_VERIFY_MERGE_INPUT',
    );
  });

  test('the LAST line is the document — bin/check --json prints the build first', () => {
    const doc = renderJson({
      ok: true,
      command: 'verify',
      summary: 's',
      steps: [{ name: 'lint', ok: true, durationMs: 3, findings: [] }],
      data: { durationMs: 3 },
    });
    const read = parsePart('p.json', `{"command":"build","ok":true}\n${doc}\n`);
    expect(read.steps.map((s) => s.name)).toEqual(['lint']);
    expect(read.durationMs).toBe(3);
  });

  test('the command: no part is refused, a missing file is refused, parts merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-merge-'));
    try {
      writeFileSync(join(dir, 'app.config.ts'), 'export default {};\n');
      const ctx = (argv: string[]) =>
        ({
          cwd: dir,
          args: parseArgs(['verify', ...argv], SPECS),
          env: {},
          runner: async () => {
            throw new Error('merge spawns nothing');
          },
        }) as unknown as Parameters<typeof verifyCommand.run>[0];
      expect((await verifyCommand.run(ctx(['merge'])).catch((e) => e)).code).toBe('X_CLI_BAD_FLAG');
      expect((await verifyCommand.run(ctx(['merge', 'gone.json'])).catch((e) => e)).code).toBe(
        'X_VERIFY_MERGE_INPUT',
      );
      writeFileSync(
        join(dir, 'p.json'),
        renderJson({ ok: true, command: 'verify', summary: 's', steps: [], data: {} }),
      );
      const merged = await verifyCommand.run(ctx(['merge', 'p.json']));
      // One empty part is not the gate: every declared step is missing.
      expect(merged.ok).toBe(false);
      expect(merged.steps?.every((step) => !step.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
