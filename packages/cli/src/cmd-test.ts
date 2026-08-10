// `x test`'s command surface: the flags and the one positional it accepts, and the refusals that
// happen before a single process starts. Which files run is test-select.ts, how they are split and
// spawned is test-shards.ts — this file only turns argv into their inputs, so a parsing bug can
// never be read as a sharding one.

// Bun ships no CPU-count primitive; `cpus()` is the fallback when navigator cannot answer.
import { cpus } from 'node:os';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, NoTestFilesError } from './errors';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import { discoverTests, missingSelection, readSample, readType, sampleFiles } from './test-select';
import { quoteArg, runShards } from './test-shards';
import type { TestType } from './verify-tests';
import { TEST_TYPES } from './verify-tests';

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

function readIndex(args: ParsedArgs, name: string, min: number): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new BadFlagError({
      flag: name,
      command: 'test',
      reason: `expects an integer >= ${min}, got "${raw}"`,
    });
  }
  return value;
}

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

export const testCommand: CliCommand = {
  spec: {
    name: 'test',
    summary:
      'run one test type — or the whole suite — across N processes, one isolated database per worker',
    usage: `x test [${TEST_TYPES.join('|')}] [--filter text] [--sample N] [--workers N] [--worker I] [--json]`,
    flags: [
      { name: 'workers', type: 'string', summary: 'process count (default: available CPUs)' },
      {
        name: 'worker',
        type: 'string',
        summary: 'rerun only shard I of the same split — reproduces a CI worker failure locally',
      },
      { name: 'filter', type: 'string', summary: 'only files whose path contains this substring' },
      {
        name: 'sample',
        type: 'string',
        summary:
          'run at most N files of the selected type — a fast signal for the eval loop, never a gate',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const type = readOnlyType(ctx.args.positionals);
    const filter = flagString(ctx.args, 'filter');
    const sample = readSample(ctx.args);
    const discovered = await discoverTests(ctx.cwd, filter, type);
    if (discovered.length === 0) {
      throw new NoTestFilesError({ root: ctx.cwd, ...missingSelection(type, filter) });
    }
    const files = sample === undefined ? discovered : sampleFiles(discovered, sample);
    const requested = readIndex(ctx.args, 'workers', 1) ?? availableCpus();
    const workers = Math.max(1, Math.min(requested, files.length));
    const only = readIndex(ctx.args, 'worker', 0);
    if (only !== undefined && only >= workers) {
      throw new BadFlagError({
        flag: 'worker',
        command: 'test',
        reason: `shard ${only} does not exist in a ${workers}-worker split (0..${workers - 1})`,
      });
    }
    return runShards({
      root: ctx.cwd,
      runner: ctx.runner,
      files,
      workers,
      ...(only === undefined ? {} : { only }),
      ...(filter === undefined ? {} : { filter }),
      ...(type === undefined ? {} : { type }),
      // `kept` is the corpus the split saw; a `--worker` rerun must name it, not its own shard.
      ...(sample === undefined ? {} : { sample: { kept: files.length, total: discovered.length } }),
    });
  },
};
