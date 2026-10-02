// The parts rule, both ways round: a split that IS the gate has no gaps, and each way of not being
// the gate is named. Fixture worlds, so a failure here is about the rule and never about ci.yml.

import { describe, expect, test } from 'bun:test';
import type { GatePart } from './ci-parts';
import { partGaps, scriptCalls, shardOf, shardSetGaps } from './ci-parts';

const STEPS = ['typecheck', 'lint', 'unit', 'live', 'roadmap'];
const SHARDABLE = ['unit'];

const whole: readonly GatePart[] = [
  { part: 'static', only: ['typecheck', 'lint', 'roadmap'] },
  { part: 'unit-1', only: ['unit'], shard: '1/2' },
  { part: 'unit-2', only: ['unit'], shard: '2/2' },
  { part: 'live', only: ['live'] },
];

const without = (name: string): readonly GatePart[] => whole.filter((part) => part.part !== name);

describe('partGaps', () => {
  test('parts that add up to the step list exactly once have no gaps', () => {
    expect(partGaps(whole, STEPS, SHARDABLE)).toEqual([]);
  });

  test('a step no part runs is named', () => {
    expect(partGaps(without('live'), STEPS, SHARDABLE)).toEqual(['live is in no part']);
  });

  test('a step dropped from a part’s list is named, though the part is still there', () => {
    const parts = [{ part: 'static', only: ['typecheck', 'lint'] }, ...without('static')];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual(['roadmap is in no part']);
  });

  test('a step two parts run whole is named with both parts', () => {
    const parts = [...whole, { part: 'again', only: ['lint'] }];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual(['lint is in 2 parts (static, again)']);
  });

  test('a step run whole AND in shards is refused', () => {
    const parts = [...whole, { part: 'unit-all', only: ['unit'] }];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual([
      'unit is in 3 parts (unit-1, unit-2, unit-all)',
    ]);
  });

  test('a missing shard is named as i/n', () => {
    expect(partGaps(without('unit-2'), STEPS, SHARDABLE)).toEqual(['unit has no shard 2/2']);
  });

  test('a shard of a step that cannot be split is refused', () => {
    const parts = [...without('live'), { part: 'live', only: ['live'], shard: '1/1' }];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual(['live shards live, which cannot be split']);
  });

  test('a name the gate does not have is refused, never ignored', () => {
    const parts = [...whole, { part: 'extra', only: ['typechek'] }];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual([
      'extra names typechek, which is not a gate step',
    ]);
  });

  test('two parts under one name are refused: one artifact would overwrite the other', () => {
    const parts = [...without('unit-2'), { part: 'unit-1', only: ['unit'], shard: '2/2' }];
    expect(partGaps(parts, STEPS, SHARDABLE)).toEqual(['two parts are named unit-1']);
  });
});

describe('shardSetGaps', () => {
  test('1..n once is whole', () => {
    expect(shardSetGaps('packages', ['2/3', '1/3', '3/3'])).toEqual([]);
  });

  test('mixed splits, a repeat and a non-shard are each named', () => {
    expect(shardSetGaps('packages', ['1/2', '2/3'])).toEqual(['packages mixes splits of 2 and 3']);
    expect(shardSetGaps('packages', ['1/2', '1/2'])).toEqual([
      'packages has no shard 2/2',
      'packages has shard 1/2 more than once',
    ]);
    expect(shardSetGaps('packages', ['1', '2/2'])).toEqual([
      'packages carries a shard that is not i/n (1, 2/2)',
    ]);
  });

  test('a shard past its own total is not a shard', () => {
    expect(shardOf('3/2')).toBeUndefined();
    expect(shardOf('0/2')).toBeUndefined();
    expect(shardOf('2/2')).toEqual({ index: 2, total: 2 });
  });
});

describe('scriptCalls', () => {
  test('reads the flags of a wrapped invocation and the subcommand of a bare one', () => {
    const run = [
      'mkdir -p parts',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, verbatim
      'bun run scripts/verify.ts --only "$ONLY" ${SHARD:+--shard "$SHARD"} --json \\',
      '  > "parts/x.json" || status=$?',
      'bun run scripts/verify.ts merge parts/*.json --json',
      '# bun run scripts/verify.ts --verbose is a comment, not a call',
    ].join('\n');

    expect(scriptCalls(run, 'scripts/verify.ts')).toEqual([
      { flags: ['only', 'shard', 'json'] },
      { subcommand: 'merge', flags: ['json'] },
    ]);
  });
});
