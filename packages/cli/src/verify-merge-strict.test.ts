// `x verify merge` judges strict where the shards could not: a split step whose shards together
// ran nothing. And the merged document carries every part's zero-check reasons, as a whole run does.

import { describe, expect, test } from 'bun:test';
import { msg } from './messages';
import { parseVerifyFloor } from './verify-floor';
import type { VerifyPart } from './verify-merge';
import { mergeParts, parsePart } from './verify-merge';
import { shardFiles } from './verify-shard';
import { STRICT_UNRUN_CODE } from './verify-strict';

const DECLARED = ['lint', 'unit', 'e2e'];
const FILES = ['a.test.ts', 'b.test.ts'];

const emptyShard = (index: number) => ({
  name: 'unit',
  ok: true,
  durationMs: 10,
  skipped: false,
  findings: [],
  tests: { ran: 0, skipped: 0 },
  shard: shardFiles(FILES, { index, total: 2 }),
});

const lint = { name: 'lint', ok: true, durationMs: 5, skipped: false, findings: [] };
const e2e = { name: 'e2e', ok: true, durationMs: 0, skipped: true, findings: [] };

const part = (
  file: string,
  steps: VerifyPart['steps'],
  skipReasons?: Readonly<Record<string, string>>,
): VerifyPart => ({
  file,
  durationMs: 10,
  steps,
  ...(skipReasons === undefined ? {} : { skipReasons }),
});

const parts = (): VerifyPart[] => [
  part('static.json', [lint, e2e], { e2e: 'no *.e2e.test.ts file in this tree' }),
  part('u1.json', [emptyShard(1)]),
  part('u2.json', [emptyShard(2)]),
];

const floorOf = (text: string) => parseVerifyFloor(text, DECLARED);

interface Data {
  readonly failed: readonly string[];
  readonly skipReasons?: Readonly<Record<string, string>>;
  readonly unwaived?: readonly string[];
}

describe('strict: x verify merge over shards that each ran nothing', () => {
  test('a strict floor turns the split step red, with the reason the sum gives', () => {
    const result = mergeParts(
      parts(),
      floorOf('{"steps":["lint"],"strict":true,"skip":{"e2e":"JSON API only"}}'),
      DECLARED,
    );
    expect(result.ok).toBe(false);
    expect((result.data as unknown as Data).failed).toEqual(['unit']);
    const unit = result.steps?.find((step) => step.name === 'unit');
    expect(unit?.findings.map((finding) => finding.code)).toEqual([STRICT_UNRUN_CODE]);
    expect(unit?.skipped).toBeUndefined();
  });

  test('not strict: green, every reason carried, the unexcused steps warned', () => {
    const result = mergeParts(parts(), undefined, DECLARED);
    expect(result.ok).toBe(true);
    const data = result.data as unknown as Data;
    expect(data.skipReasons).toEqual({
      unit: msg('cli.verify.ranNothing'),
      e2e: 'no *.e2e.test.ts file in this tree',
    });
    expect(data.unwaived).toEqual(['unit', 'e2e']);
    expect(result.lines?.at(-1)).toBe(msg('cli.verify.unwaived', { names: 'unit, e2e' }));
  });

  test("a part's data.skipReasons is read back out of its document", () => {
    const doc = JSON.stringify({
      command: 'verify',
      steps: [e2e],
      data: { durationMs: 1, skipReasons: { e2e: 'why' } },
    });
    expect(parsePart('p.json', doc).skipReasons).toEqual({ e2e: 'why' });
  });
});
