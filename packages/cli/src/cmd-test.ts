// `x test`'s command surface: the flags and the one positional it accepts, and the refusals that
// happen before a single process starts. Which files run is test-select.ts, how they are split and
// spawned is test-shards.ts — this file only turns argv into their inputs, so a parsing bug can
// never be read as a sharding one. `--affected` is the one narrowing decided here rather than
// there, because it is a fact about a git diff and not about a path: what the diff touches is
// `affected.ts`, and this file only maps that answer onto the paths discovery yields.

import type { AffectedScope } from './affected';
import { affectedScope, affectedScopeJson, DEFAULT_BASE, inScope } from './affected';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { BadFlagError, NoTestFilesError } from './errors';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { quoteArg } from './shell-quote';
import { discoverTests, missingSelection, readSample, readType, sampleFiles } from './test-select';
import { runShards } from './test-shards';
import { defaultWorkers, WORKER_CEILING, WORKER_FLOOR, WORKER_OVERSUBSCRIBE } from './test-workers';
import type { TestType } from './verify-tests';
import { SERIAL_TYPES, TEST_TYPES } from './verify-tests';

/**
 * `--workers` and `--shard`. `Number.parseInt` alone accepted `4abc` and `4.9` as four, while
 * `cmd-verify.ts`'s own comment claimed `x test --workers` refused the same values `x verify`
 * does — so the two commands disagreed about the same flag. One reader now answers for both.
 */
const readIndex = (args: ParsedArgs, name: string, min: number): number | undefined =>
  readIntFlag(args, {
    name,
    command: 'test',
    min,
    // The ceiling the summary already claimed and the reader never enforced: `--workers 5000` was
    // accepted and the run clamps only to the file count, which is one Bun worker per test FILE,
    // each with the framework module graph and a cloned database. `--worker` is an index into an
    // N-way split, so the same bound holds it (the exact upper index is `workers - 1`, refused a
    // line below by the check that knows the real width).
    max: WORKER_CEILING,
    example: `x test --${name} ${Math.max(min, 1)}`,
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

export const testCommand: CliCommand = {
  spec: {
    name: 'test',
    summary:
      'run one test type — or the whole suite — across N workers, one isolated database per worker',
    usage: `x test [${TEST_TYPES.join('|')}] [--filter text] [--sample N] [--affected [--base ref] [--dirty]] [--workers N] [--worker I] [--json]`,
    positionalChoices: TEST_TYPES,
    flags: [
      {
        name: 'workers',
        type: 'string',
        summary: `process count (default: ${WORKER_OVERSUBSCRIBE}x CPUs, min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
      },
      {
        name: 'worker',
        type: 'string',
        summary:
          'run only shard I of an N-way split of the selection, serially — one CI job\u2019s share',
      },
      { name: 'filter', type: 'string', summary: 'only files whose path contains this substring' },
      {
        name: 'sample',
        type: 'string',
        summary:
          'run at most N files of the selected type — a fast signal for the eval loop, never a gate',
      },
      {
        name: 'affected',
        type: 'boolean',
        summary: 'only the workspaces a diff touches, and everything that depends on one of them',
      },
      {
        name: 'base',
        type: 'string',
        summary: `--affected: git ref to diff against, merge-base style (default: ${DEFAULT_BASE})`,
      },
      {
        name: 'dirty',
        type: 'boolean',
        summary:
          '--affected: also count uncommitted work, whichever agent in this checkout made it',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const type = readOnlyType(ctx.args.positionals);
    const filter = flagString(ctx.args, 'filter');
    const sample = readSample(ctx.args);
    const scope = await readAffectedScope(ctx);
    const discovered = await discoverTests(ctx.cwd, filter, type);
    if (discovered.length === 0) {
      throw new NoTestFilesError({ root: ctx.cwd, ...missingSelection(type, filter) });
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
    const requested = readIndex(ctx.args, 'workers', 1) ?? defaultWorkers();
    // A serial type is serial HERE TOO, `As of 2026-08-27`. `verify-tests.ts` routes `live` and
    // `e2e` through `runSerial` and this command never read the same list, so `x verify` ran one
    // process over the very files `x test live --workers 8` ran eight over — two answers to one
    // question, which is axiom 1, and the dangerous one is the command a human types while
    // debugging. What makes them serial is not a preference: a logical replication slot is named
    // at the Postgres CLUSTER level, so a per-worker database does not isolate it and two workers
    // race `pg_create_logical_replication_slot`; `e2e` shares one built `dist/` and one browser
    // profile. Neither is visible without a real `TEST_DATABASE_URL`, which is why the split
    // measured green for as long as it did.
    const ceiling = type !== undefined && SERIAL_TYPES.includes(type) ? 1 : files.length;
    const workers = Math.max(1, Math.min(requested, ceiling));
    const only = readIndex(ctx.args, 'worker', 0);
    if (only !== undefined && only >= workers) {
      throw new BadFlagError({
        flag: 'worker',
        command: 'test',
        reason: `shard ${only} does not exist in a ${workers}-worker split (0..${workers - 1})`,
      });
    }
    const result = await runShards({
      root: ctx.cwd,
      runner: ctx.runner,
      files,
      workers,
      ...(only === undefined ? {} : { only }),
      ...(filter === undefined ? {} : { filter }),
      ...(type === undefined ? {} : { type }),
      // `kept` is the corpus the split saw; a `--worker` rerun must name it, not its own shard.
      // `selected`, not `discovered`: with `--affected` the sample was taken from the narrowed
      // set, and reporting the whole tree as its total would name a corpus no run ever had.
      ...(sample === undefined ? {} : { sample: { kept: files.length, total: selected.length } }),
      // The fourth input to the split. Without it a failing shard's `fix:` re-splits the whole
      // corpus, so its shard 2 is a different shard 2 — reproducing nothing, which is the one
      // thing `reproduceFor` exists to prevent.
      ...(scope === undefined ? {} : { affected: scope.selection }),
    });
    return scope === undefined ? result : withScope(result, scope);
  },
};
