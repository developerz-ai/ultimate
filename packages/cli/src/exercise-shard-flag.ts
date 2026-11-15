// `x exercise --shard i/n`: one of n processes' slice of the pass (`@ultimat3/testing`'s
// `exercise-shard.ts`), each on its own scratch database. A slice writes its own report beside the
// whole pass's, and judges no whole-pass floor: a ratio over a third of the pass is not the pass's.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import type { ShardSpec } from './verify-shard';
import { parseShard, VerifyShardInvalidError } from './verify-shard';

const COMMAND = 'x exercise';

/** `--shard`, read: absent, the whole pass. Refused beside a `<name>`, which is a slice already. */
export function readExerciseShard(
  args: ParsedArgs,
  only: string | undefined,
): ShardSpec | undefined {
  const raw = flagString(args, 'shard');
  if (raw === undefined) return undefined;
  let spec: ShardSpec;
  try {
    spec = parseShard(raw, COMMAND);
  } catch {
    // The verify step's fix names `--only`, which this command has not: the reason, with ours.
    throw new VerifyShardInvalidError({
      reason: 'expects i/n with 1 <= i <= n (e.g. 2/4)',
      fix: `${COMMAND} --shard 1/2 --json`,
      command: COMMAND,
    });
  }
  if (only !== undefined) {
    throw new VerifyShardInvalidError({
      reason: 'a shard is a slice of the whole pass, and a <name> already runs one primitive',
      fix: `${COMMAND} --shard ${String(spec.index)}/${String(spec.total)} --json`,
      command: COMMAND,
    });
  }
  return spec;
}

/** Where a slice's report goes: `.x/exercise.2-of-4.json`, never over the whole pass's file. */
export const shardReportFile = (shard: ShardSpec | undefined): string =>
  shard === undefined
    ? EXERCISE_REPORT_FILE
    : join('.x', `exercise.${String(shard.index)}-of-${String(shard.total)}.json`);
