// The repo gate's own flags, read and refused in one place. `bun run verify --only lint` used to
// parse `--only` into a map nothing read and run all 20 steps, and a typo'd flag did the same:
// a narrowing that silently widens is the gate lying about what it checked.

import { BadFlagError } from '../../packages/cli/src/errors';
import type { ShardSpec } from '../../packages/cli/src/verify-shard';
import { assertShardable, parseShard } from '../../packages/cli/src/verify-shard';
import type { VerifyStepName } from '../../packages/cli/src/verify-step';
import { VERIFY_STEP_NAMES } from '../../packages/cli/src/verify-step';
import { nearestName } from '../../packages/core/src/nearest-name';
import type { ScriptArgs } from './args';

/**
 * The gate as it is typed at the framework root. `x verify` answers `X_NOT_IN_APP` here, so every
 * refusal and every finding this entry raises is handed this spelling for its `fix:`.
 */
export const REPO_GATE = 'bun run verify';

/** Every flag `scripts/verify.ts` reads. Anything else is refused before a step starts. */
export const VERIFY_FLAGS = ['json', 'verbose', 'workers', 'only', 'shard', 'timings'] as const;

/**
 * The one word that may follow the script: `merge <part.json…>` folds the parts CI ran on separate
 * runners back into the gate's verdict. No word is the gate itself.
 */
export const VERIFY_SUBCOMMANDS = ['merge'] as const;

export interface VerifyArgs {
  /** The steps `--only` names, in the gate's declared order whatever order they were typed in. */
  readonly only?: readonly VerifyStepName[];
  readonly workers?: number;
  /** `--shard i/n`: one CI runner's slice of the parallel suites `--only` names. */
  readonly shard?: ShardSpec;
  /** `--timings <file>`, with `--shard`: the caller reads it, so this stays synchronous. */
  readonly timings?: string;
}

const isStep = (raw: string): raw is VerifyStepName =>
  (VERIFY_STEP_NAMES as readonly string[]).includes(raw);

/** The list as it would be with each typo corrected, or the gate when an item resembles nothing. */
const fixFor = (items: readonly string[]): string => {
  const corrected = items.map((item) =>
    isStep(item) ? item : nearestName(item, VERIFY_STEP_NAMES),
  );
  return corrected.every((item) => item !== undefined)
    ? `bun run verify --only ${[...new Set(corrected)].join(',')}`
    : 'bun run verify --json';
};

// Every arm is a command that runs: a bare `--only` with no step is not one.
const unknownFlagFix = (name: string, value: string | boolean | undefined): string => {
  const near = nearestName(name, VERIFY_FLAGS);
  if (near === 'only') return fixFor(typeof value === 'string' ? value.split(',') : ['']);
  if (near === 'workers') return 'bun run verify --workers 4';
  if (near === 'shard') return 'bun run verify --only unit --shard 1/3 --json';
  if (near === 'timings') return 'bun run verify --only unit --shard 1/3 --json';
  return near === undefined ? 'bun run verify --json' : `bun run verify --${near}`;
};

/**
 * `--only a,b,c`: the same comma list `x verify --only` takes, refused item by item. An empty item
 * (`lint,,drift`, a trailing comma, a bare `--only`) is refused too — never read as "no steps".
 */
const readOnly = (raw: string | boolean | undefined): readonly VerifyStepName[] | undefined => {
  if (raw === undefined) return undefined;
  const items = (typeof raw === 'string' ? raw : '').split(',').map((item) => item.trim());
  const unknown = items.filter((item) => !isStep(item));
  if (unknown.length === 0) return VERIFY_STEP_NAMES.filter((name) => items.includes(name));
  const named = unknown.map((item) => (item === '' ? '(none given)' : item)).join(', ');
  throw new BadFlagError({
    flag: 'only',
    command: 'verify',
    reason: `unknown step ${named}`,
    fix: fixFor(items),
  });
};

/** Refuses an unknown flag or step with `X_CLI_BAD_FLAG`; never narrows to nothing. */
export function readVerifyArgs(args: ScriptArgs): VerifyArgs {
  for (const name of args.flags.keys()) {
    if ((VERIFY_FLAGS as readonly string[]).includes(name)) continue;
    throw new BadFlagError({
      flag: name,
      command: 'verify',
      reason: `unknown flag --${name}`,
      fix: unknownFlagFix(name, args.flags.get(name)),
    });
  }
  const only = readOnly(args.flags.get('only'));
  const rawWorkers = args.flags.get('workers');
  const n = typeof rawWorkers === 'string' ? Number.parseInt(rawWorkers, 10) : Number.NaN;
  const workers = Number.isFinite(n) && n > 0 ? n : undefined;

  const rawShard = args.flags.get('shard');
  const timings = args.flags.get('timings');
  if (rawShard === undefined && timings !== undefined) {
    throw new BadFlagError({
      flag: 'timings',
      command: 'verify',
      reason: '--timings balances a --shard split and does nothing without one',
      fix: 'bun run verify --only unit --shard 1/3 --json',
    });
  }
  let shard: ShardSpec | undefined;
  if (rawShard !== undefined) {
    // The CLI's own two refusals, so a split this script accepts is one `x verify merge` can fold.
    shard = parseShard(typeof rawShard === 'string' ? rawShard : '', REPO_GATE);
    assertShardable(only, REPO_GATE);
  }
  return {
    ...(only === undefined ? {} : { only }),
    ...(workers === undefined ? {} : { workers }),
    ...(shard === undefined ? {} : { shard }),
    ...(typeof timings === 'string' ? { timings } : {}),
  };
}
