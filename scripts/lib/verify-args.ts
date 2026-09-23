// The repo gate's own flags, read and refused in one place. `bun run verify --only lint` used to
// parse `--only` into a map nothing read and run all 20 steps, and a typo'd flag did the same:
// a narrowing that silently widens is the gate lying about what it checked.

import { BadFlagError } from '../../packages/cli/src/errors';
import type { VerifyStepName } from '../../packages/cli/src/verify-step';
import { VERIFY_STEP_NAMES } from '../../packages/cli/src/verify-step';
import { nearestName } from '../../packages/core/src/nearest-name';
import type { ScriptArgs } from './args';

/** Every flag `scripts/verify.ts` reads. Anything else is refused before a step starts. */
export const VERIFY_FLAGS = ['json', 'verbose', 'workers', 'only'] as const;

export interface VerifyArgs {
  readonly only?: VerifyStepName;
  readonly workers?: number;
}

const fixFor = (raw: string): string => {
  const near = nearestName(raw, VERIFY_STEP_NAMES);
  return near === undefined ? 'bun run verify --json' : `bun run verify --only ${near}`;
};

// Every arm is a command that runs: a bare `--only` with no step is not one.
const unknownFlagFix = (name: string, value: string | boolean | undefined): string => {
  const near = nearestName(name, VERIFY_FLAGS);
  if (near === 'only') return fixFor(typeof value === 'string' ? value : '');
  if (near === 'workers') return 'bun run verify --workers 4';
  return near === undefined ? 'bun run verify --json' : `bun run verify --${near}`;
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
  const rawOnly = args.flags.get('only');
  let only: VerifyStepName | undefined;
  if (rawOnly !== undefined) {
    const value = typeof rawOnly === 'string' ? rawOnly : '';
    only = VERIFY_STEP_NAMES.find((name) => name === value);
    if (only === undefined) {
      throw new BadFlagError({
        flag: 'only',
        command: 'verify',
        reason: `unknown step ${value === '' ? '(none given)' : value}`,
        fix: fixFor(value),
      });
    }
  }
  const rawWorkers = args.flags.get('workers');
  const n = typeof rawWorkers === 'string' ? Number.parseInt(rawWorkers, 10) : Number.NaN;
  const workers = Number.isFinite(n) && n > 0 ? n : undefined;
  return {
    ...(only === undefined ? {} : { only }),
    ...(workers === undefined ? {} : { workers }),
  };
}
