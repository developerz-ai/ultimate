// `x verify` — the contract. Every check is a named step with its own pass/fail and duration, the
// same list in the terminal and in --json, and a non-zero exit if any step fails. Green means
// shippable (axiom 5): one step list, no second checklist, no CI-only step.
//
// `--only <step>[,<step>…]` is the ONE narrowing, decided as D6, and it does not weaken that: the
// GATE is the no-flag run, and a narrowed run says `NOT A GATE RUN` in the summary and in `--json` so no
// reader of either can take it for one. `--skip` stays refused — it would let a caller drop the
// step that was going to fail and still read the output as a whole-tree verdict.

// why: Bun ships no path-joining primitive: `join`/`isAbsolute` resolve a part path against the cwd.
import { isAbsolute, join } from 'node:path';
import { nearestName, renderFixShellArg } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { verifySpec } from './cmd-verify-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { readIntFlag } from './flag-number';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { WORKER_CEILING, WORKER_FLOOR } from './test-workers';
import { VERIFY_STEPS } from './verify-checks';
import { VerifyMergeInputError, VerifyShardInvalidError } from './verify-errors';
import { readVerifyFloor } from './verify-floor';
import type { VerifyPart } from './verify-merge';
import { coverageRiders, mergeParts, parsePart } from './verify-merge';
import { stepStream } from './verify-progress';
import { runVerify } from './verify-run';
import type { ShardSpec, Timings } from './verify-shard';
import { assertShardable, parseShard, readTimings } from './verify-shard';
import type { VerifyStepName } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';
import { writeErrorLine } from './write-line';

// One import path for the gate, unchanged by the split: `index.ts`, `x build` and the MCP host all
// reach the list and the runner through this module, and a second path to either would be the
// ambiguity axiom 1 forbids.
export { VERIFY_STEPS } from './verify-checks';
export { runVerify } from './verify-run';

export const verifyCommand: CliCommand = {
  spec: verifySpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('verify', ctx.cwd).dir;
    if (ctx.args.subcommand === 'merge') return mergeCommand(root, ctx.args.positionals, ctx.cwd);
    // Every reader before the run: an unrunnable flag must be refused in milliseconds, not after
    // `tsc -b` has spent fourteen seconds on a run the caller cannot use.
    const workers = readWorkers(ctx.args);
    const only = readOnlySteps(ctx.args);
    const shard = await readShard(ctx.args, only);
    const isolate = flagBool(ctx.args, 'isolate') ? true : undefined;
    const result = await runVerify(VERIFY_STEPS, {
      root,
      runner: ctx.runner,
      env: ctx.env,
      ...(workers === undefined ? {} : { workers }),
      ...(only === undefined ? {} : { only }),
      ...(shard === undefined ? {} : { shard }),
      ...(isolate === undefined ? {} : { isolate }),
      // `--json` prints one document when the run ends; a line per finished step on stderr is
      // what a cancelled CI job's log ends on (#589). stdout stays the single document.
      ...stepStream(ctx.args.json, writeErrorLine),
    });
    return shard === undefined ? result : withShardData(result, shard);
  },
};

/**
 * `--shard i/n` (and `--timings`), validated before anything runs: only beside `--only`, and only
 * over the parallel suites. `--timings` without `--shard` is refused rather than ignored.
 */
export async function readShard(
  args: ParsedArgs,
  only: readonly VerifyStepName[] | undefined,
): Promise<(ShardSpec & { readonly timings?: Timings }) | undefined> {
  const raw = flagString(args, 'shard');
  const timingsPath = flagString(args, 'timings');
  if (raw === undefined) {
    if (timingsPath !== undefined) {
      throw new VerifyShardInvalidError({
        reason: '--timings balances a --shard split and does nothing without one',
      });
    }
    return undefined;
  }
  const spec = parseShard(raw);
  assertShardable(only);
  if (timingsPath === undefined) return spec;
  return { ...spec, timings: await readTimings(timingsPath) };
}

/** `data.shard`: which slice this part is, per step — what `x verify merge` reads back. */
const withShardData = (result: CommandResult, shard: ShardSpec): CommandResult => {
  const data = (result.data ?? {}) as Record<string, JsonValue>;
  const steps: Record<string, JsonValue> = {};
  for (const step of result.steps ?? []) {
    if (step.shard === undefined) continue;
    steps[step.name] = { corpusHash: step.shard.corpusHash, files: [...step.shard.files] };
  }
  return {
    ...result,
    data: { ...data, shard: { index: shard.index, total: shard.total, steps } },
  };
};

async function mergeCommand(
  root: string,
  files: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  if (files.length === 0) {
    throw new MissingPositionalError({
      command: 'verify merge',
      positional: 'part.json…',
      example: 'x verify merge parts/*.json --json',
    });
  }
  const parts: VerifyPart[] = [];
  for (const file of files) {
    const path = isAbsolute(file) ? file : join(cwd, file);
    const handle = Bun.file(path);
    if (!(await handle.exists())) {
      throw new VerifyMergeInputError({ file, reason: 'does not exist' });
    }
    parts.push(parsePart(file, await handle.text()));
  }
  const floor = await readVerifyFloor(root);
  return mergeParts(parts, floor, VERIFY_STEP_NAMES, {
    riders: await coverageRiders(parts, root, floor),
  });
}

/**
 * The steps `--only` names, or nothing: one step (`--only lint`) or a comma-separated list
 * (`--only typecheck,lint,boundaries`) run in ONE process, in the gate's declared order whatever
 * order they were typed in. Refused against `VERIFY_STEP_NAMES` — the same constant the runner's
 * list is built from — so a typo can never be read as "narrow to no steps at all", which is a run
 * that passes by checking nothing. An empty item (`lint,,drift`, a trailing comma) is refused for
 * the same reason.
 *
 * A near miss leads with the list as it would be with each typo corrected; an item near NOTHING
 * gets the gate itself rather than an invented lead, which is the rule `parse.ts` already follows
 * for a command that resembles none. Both arms are commands that run.
 */
export const readOnlySteps = (args: ParsedArgs): readonly VerifyStepName[] | undefined => {
  const raw = flagString(args, 'only');
  if (raw === undefined) return undefined;
  const items = raw.split(',').map((item) => item.trim());
  const unknown = items.filter((item) => !isStepName(item));
  if (unknown.length === 0) {
    return VERIFY_STEP_NAMES.filter((name) => items.includes(name));
  }
  // An empty item corrects to nothing — never to whichever step is nearest to ''.
  const corrected = items.map((item) =>
    isStepName(item) ? item : item === '' ? undefined : nearestName(item, VERIFY_STEP_NAMES),
  );
  const fix = corrected.every((item) => item !== undefined)
    ? `x verify --only ${renderFixShellArg([...new Set(corrected)].join(','), '<step,step>')} --json`
    : 'x verify --json';
  const named = unknown.map((item) => (item === '' ? '(empty)' : `"${item}"`)).join(', ');
  throw new BadFlagError({
    flag: 'only',
    command: 'verify',
    reason: `${named} ${unknown.length === 1 ? 'is not a gate step' : 'are not gate steps'} (${VERIFY_STEP_NAMES.join(', ')})`,
    fix,
  });
};

const isStepName = (raw: string): raw is VerifyStepName =>
  (VERIFY_STEP_NAMES as readonly string[]).includes(raw);

/**
 * Both bounds are the constants the flag summary already names, so `x help verify` and the reader
 * cannot disagree. Exported for the test that pins them: the command's `run` reaches this only
 * after the whole gate would have started.
 *
 * `max` is the ceiling. Without it `--workers 5000` parsed, `planShards` clamped only to the file
 * count, and `runParallel` `Promise.all`ed one Bun process per test file. `min` is `WORKER_FLOOR`,
 * the same number `defaultWorkers` will not go below — the gate spreads or it does not shard, and
 * `--workers 1` was a serial run the summary said was impossible. `x test --workers 1` stays legal
 * and is deliberately NOT this reader: `runShards` clamps the width to the file count, so a
 * one-file corpus makes `X_TEST_SHARD_FAILED`'s own `fix:` say `--workers 1`.
 */
export const readWorkers = (args: ParsedArgs): number | undefined =>
  readIntFlag(args, {
    name: 'workers',
    command: 'verify',
    min: WORKER_FLOOR,
    max: WORKER_CEILING,
    example: 'x verify --workers 4',
  });

export const verifyStepNames = (): readonly VerifyStepName[] =>
  VERIFY_STEPS.map((step) => step.name);
