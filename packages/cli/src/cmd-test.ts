// `x test`'s command surface: the flags and the one positional it accepts, and the refusals that
// happen before a single process starts. Which files run is test-select.ts, how they are split and
// spawned is test-shards.ts — this file only turns argv into their inputs, so a parsing bug can
// never be read as a sharding one. `--affected` is the one narrowing decided here rather than
// there, because it is a fact about a git diff and not about a path: what the diff touches is
// `affected.ts`, and this file only maps that answer onto the paths discovery yields.

import type { AffectedScope } from './affected';
import { affectedScope, affectedScopeJson, DEFAULT_BASE, inScope } from './affected';
import { testSpec } from './cmd-test-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { BadFlagError, NoTestFilesError } from './errors';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { quoteArg } from './shell-quote';
import {
  discoverTests,
  missingSelection,
  readFilters,
  readSample,
  readType,
  sampleFiles,
} from './test-select';
import { runShards } from './test-shards';
import { machineLease } from './test-slots';
import type { WorkerPlan } from './test-workers';
import {
  availableCpus,
  SERIAL_TYPES,
  totalMemory,
  WORKER_CEILING,
  workerPlan,
} from './test-workers';
import { readVerifyFloor } from './verify-floor';
import type { TestType } from './verify-tests';
import { TEST_TYPES } from './verify-tests';

/**
 * `--workers`. `Number.parseInt` alone accepted `4abc` and `4.9` as four, while `cmd-verify.ts`'s
 * own comment claimed `x test --workers` refused the same values `x verify` does — so the two
 * commands disagreed about the same flag. One reader now answers for both.
 */
const readWorkers = (args: ParsedArgs): number | undefined =>
  readIntFlag(args, {
    name: 'workers',
    command: 'test',
    min: 1,
    // The ceiling the summary already claimed and the reader never enforced: `--workers 5000` was
    // accepted and the run clamps only to the file count, which is one Bun worker per test FILE,
    // each with the framework module graph and a cloned database.
    max: WORKER_CEILING,
    example: 'x test --workers 1',
  });

/**
 * One positional, and it is the type. `x test contract live` used to run `contract` and drop
 * `live` on the floor, so a caller reading "contract passed" believed two suites had run. A path
 * substring is what `--filter` is for, which is what the fix hands back.
 */
function readOnlyType(positionals: readonly string[]): TestType | undefined {
  const [first, second] = positionals;
  if (second === undefined) return readType(first);
  const known: readonly string[] = TEST_TYPES;
  const type = first !== undefined && known.includes(first) ? first : TEST_TYPES[0];
  throw new BadFlagError({
    flag: 'type',
    command: 'test',
    reason: `takes at most one test type, got ${positionals.length}: ${positionals.join(' ')}`,
    fix: `x test ${type} --filter ${quoteArg(second)}`,
  });
}

/**
 * `--affected`, and the two flags that only mean something with it. The scope itself is
 * `affected.ts`'s — `x affected` reports exactly what this narrows to, or the two commands would
 * be two answers to one question and only one of them would be the one an agent trusts.
 */
async function readAffectedScope(ctx: CommandContext): Promise<AffectedScope | undefined> {
  if (flagBool(ctx.args, 'affected')) {
    return affectedScope({ runner: ctx.runner, cwd: ctx.cwd, args: ctx.args, command: 'test' });
  }
  // A flag that parses and changes nothing is a promise `x help test` cannot keep: without
  // `--affected` the whole suite runs, and a `--base` on the line would read as if it had not.
  const idle = flagString(ctx.args, 'base') !== undefined ? 'base' : 'dirty';
  if (flagString(ctx.args, 'base') !== undefined || flagBool(ctx.args, 'dirty')) {
    throw new BadFlagError({
      flag: idle,
      command: 'test',
      reason: 'only narrows a run together with --affected, and on its own it changes nothing',
      fix: `x test --affected --${idle}${idle === 'base' ? ` ${DEFAULT_BASE}` : ''}`,
    });
  }
  return undefined;
}

// The cast is guarded by the three lines above it and is the narrowing TS will not do on its own:
// `Array.isArray` is declared `value is any[]`, which does not remove `readonly JsonValue[]` from
// the union, so every branch here still carries the array arm however the check is written.
const asObject = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : {};

/**
 * The scope, carried onto whatever the shards reported. `--json` is what an agent reads, and a
 * narrowed run that does not say what it narrowed to is indistinguishable from a full one.
 */
const withScope = (result: CommandResult, scope: AffectedScope): CommandResult => ({
  ...result,
  data: { ...asObject(result.data), affected: affectedScopeJson(scope) },
});

/** The selection that matched nothing, as one phrase for `cli.test.empty`. */
const describeSelection = (missing: { type?: string; filter?: string }): string =>
  [
    missing.type === undefined ? undefined : `type ${missing.type}`,
    missing.filter === undefined ? undefined : `"${missing.filter}"`,
  ]
    .filter((part) => part !== undefined)
    .join(' and ') || 'the selection';

export const testCommand: CliCommand = {
  spec: testSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const type = readOnlyType(ctx.args.positionals);
    const filter = flagString(ctx.args, 'filter');
    const filters = readFilters(filter);
    const sample = readSample(ctx.args);
    const scope = await readAffectedScope(ctx);
    const discovered = await discoverTests(ctx.cwd, filters, type);
    if (discovered.length === 0) {
      const missing = missingSelection(type, filter);
      // `--allow-empty` is for a caller that COMPUTED the selection — a scoped runner handing over
      // the paths a diff touched, some of which hold no test yet. Green, spawning nothing, and
      // never read as "the suite passed": the line names the selection that matched nothing and
      // `data.files` is 0. Without the flag an empty selection stays X_TEST_NO_FILES, because a
      // typo'd `--filter` typed by hand is exactly the run that must not pass.
      if (flagBool(ctx.args, 'allow-empty')) {
        return ok('test', msg('cli.test.empty', { selection: describeSelection(missing) }), {
          data: { ...missing, files: 0, empty: true },
        });
      }
      throw new NoTestFilesError({ root: ctx.cwd, ...missing });
    }
    const selected =
      scope === undefined
        ? discovered
        : discovered.filter((file) => inScope(file.path, scope.prefixes));
    if (scope !== undefined && selected.length === 0) {
      // Green, and it spawns nothing — a `.md`-only diff genuinely re-checks nothing, and failing
      // a build for editing a doc is the wrong answer. It never reads as "the suite passed": the
      // summary counts the files that ran (zero) and `data.affected` names the diff it asked about,
      // so a caller can always tell "green because nothing is affected" from "green because
      // everything passed". Nothing reaches `runShards`, whose empty file list would be a
      // `bun test` with no arguments — that is, the whole suite.
      return ok('test', msg('cli.test.affected.none', { base: scope.selection.base }), {
        data: {
          ...(type === undefined ? {} : { type }),
          files: 0,
          affected: affectedScopeJson(scope),
        },
      });
    }
    const files = sample === undefined ? selected : sampleFiles(selected, sample);
    const explicit = readWorkers(ctx.args);
    const plan =
      explicit === undefined ? workerPlan(availableCpus(), totalMemory(), ctx.env) : undefined;
    const requested = explicit ?? (plan as WorkerPlan).workers;
    const floor = await readVerifyFloor(ctx.cwd);
    const isolate = flagBool(ctx.args, 'isolate') || floor?.isolate === true;
    // A serial type is one worker whatever `--workers` says. `test-passes.ts` makes the same call
    // off the FILES, which is what decides which files really run one at a time; this keeps the
    // width the run reports and reproduces with the one it ran at.
    const ceiling = type !== undefined && SERIAL_TYPES.includes(type) ? 1 : files.length;
    const workers = Math.max(1, Math.min(requested, ceiling));
    const result = await runShards({
      root: ctx.cwd,
      runner: ctx.runner,
      env: ctx.env,
      files,
      workers,
      ...(isolate ? { isolate } : {}),
      // A default-width run leases its workers from the machine pool, so a second `x test` or
      // gate on the same box runs narrower instead of doubling its memory.
      ...(plan === undefined ? {} : withLease(machineLease(plan.workers, ctx.env))),
      ...(filter === undefined ? {} : { filter }),
      ...(type === undefined ? {} : { type }),
      // `kept` is the corpus the run saw. `selected`, not `discovered`: with `--affected` the sample was taken from the narrowed
      // set, and reporting the whole tree as its total would name a corpus no run ever had.
      ...(sample === undefined ? {} : { sample: { kept: files.length, total: selected.length } }),
      // The fourth input to the split. Without it a failing shard's `fix:` re-splits the whole
      // corpus, so its shard 2 is a different shard 2 — reproducing nothing, which is the one
      // thing `reproduceFor` exists to prevent.
      ...(scope === undefined ? {} : { affected: scope.selection }),
      // The fifth input to the split, and the one a rerun most obviously needs: `--coverage`
      // changes what a run measures, and the reproduce line carries it back out.
      ...(ctx.args.passthrough.length === 0 ? {} : { passthrough: ctx.args.passthrough }),
    });
    return scope === undefined ? result : withScope(result, scope);
  },
};

const withLease = (
  lease: ReturnType<typeof machineLease>,
): { lease?: NonNullable<ReturnType<typeof machineLease>> } =>
  lease === undefined ? {} : { lease };
