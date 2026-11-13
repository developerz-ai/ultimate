// `x verify plan --parts <n> --json`: the gate cut into CI parts, each `x verify --only <steps>
// [--shard i/n]` on a runner of its own, as one document a workflow's matrix reads by `fromJSON`.
// Derived from `VERIFY_STEP_NAMES` and `SHARDABLE_STEPS`, so a new step lands in a part without
// anyone editing a workflow — and `x verify merge` folds the parts back into the one verdict.

import { BadFlagError } from './errors';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { ParsedArgs } from './parse';
import type { VerifyStepName } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

/**
 * What a part's runner starts before the gate: nothing, the test Postgres alone, or every test
 * service. A level rather than service names — the compose file is the app's, and the workflow that
 * starts it is the one place its names are spelled.
 */
export type PartNeeds = 'none' | 'database' | 'services';

export interface PlanPart {
  /** The matrix row's name: the job's title and its artifact's, unique across the plan. */
  readonly part: string;
  /** In the gate's declared order, as `--only` runs them. */
  readonly only: readonly VerifyStepName[];
  /** `i/n` — absent on a part that runs its steps whole. */
  readonly shard?: string;
  readonly needs: PartNeeds;
}

/**
 * The three groups that are not "everything else". The suites that read the test database split
 * together; `live` alone, one process per runner (`SHARDABLE_STEPS`); `e2e` beside `typecheck`,
 * the two slow unsharded steps, so the cheap static steps finish on a runner of their own.
 */
const UNIT_STEPS: readonly VerifyStepName[] = ['unit', 'contract', 'job'];
const LIVE_STEPS: readonly VerifyStepName[] = ['live'];
const BROWSER_STEPS: readonly VerifyStepName[] = ['typecheck', 'e2e'];

/** What `x new` writes into the workflow: one static, one browser, one unit and one live runner. */
export const DEFAULT_PLAN_PARTS = 4;
/** Two unsharded parts and at least one shard of each split group: fewer is not this layout. */
export const MIN_SPLIT_PARTS = 4;
/** A bound on a typo, not on cost: GitHub caps one matrix at 256 jobs. */
export const MAX_PLAN_PARTS = 64;

const ordered = (steps: readonly VerifyStepName[]): readonly VerifyStepName[] =>
  VERIFY_STEP_NAMES.filter((name) => steps.includes(name));

const shards = (
  prefix: string,
  steps: readonly VerifyStepName[],
  total: number,
  needs: PartNeeds,
): readonly PlanPart[] =>
  Array.from({ length: total }, (_, at) => ({
    part: `${prefix}-${String(at + 1)}`,
    only: ordered(steps),
    shard: `${String(at + 1)}/${String(total)}`,
    needs,
  }));

/**
 * `parts` runners' worth of the gate. One is the whole gate on one runner. From four, the
 * runners past the two unsharded parts split the unit group and `live`, the unit group taking the
 * odd one: it holds the most files. Every step lands in exactly one part or in every shard of one
 * split — the rule `x verify merge` refuses a run by.
 */
export function verifyPlan(parts: number): readonly PlanPart[] {
  if (parts === 1) return [{ part: 'gate', only: VERIFY_STEP_NAMES, needs: 'services' }];
  const split = parts - 2;
  const grouped = new Set<VerifyStepName>([...UNIT_STEPS, ...LIVE_STEPS, ...BROWSER_STEPS]);
  return [
    ...shards('unit', UNIT_STEPS, Math.ceil(split / 2), 'database'),
    ...shards('live', LIVE_STEPS, Math.floor(split / 2), 'services'),
    { part: 'static', only: VERIFY_STEP_NAMES.filter((name) => !grouped.has(name)), needs: 'none' },
    { part: 'e2e', only: ordered(BROWSER_STEPS), needs: 'database' },
  ];
}

/** `strategy.matrix` as GitHub reads it: `only` comma-joined, `shard` only where there is one. */
export const planMatrix = (plan: readonly PlanPart[]): { readonly include: JsonValue[] } => ({
  include: plan.map((part) => ({
    part: part.part,
    only: part.only.join(','),
    ...(part.shard === undefined ? {} : { shard: part.shard }),
    needs: part.needs,
  })),
});

/** `--parts`, screened: an integer in range, and never the two counts this layout cannot make. */
export function readPlanParts(args: ParsedArgs): number {
  const example = `x verify plan --parts ${String(DEFAULT_PLAN_PARTS)} --json`;
  const parts =
    readIntFlag(args, {
      name: 'parts',
      command: 'verify plan',
      min: 1,
      max: MAX_PLAN_PARTS,
      example,
    }) ?? DEFAULT_PLAN_PARTS;
  if (parts > 1 && parts < MIN_SPLIT_PARTS) {
    throw new BadFlagError({
      flag: 'parts',
      command: 'verify plan',
      reason: `${String(parts)} runners cannot hold the static part, the browser part and a shard of each split group (1, or ${String(MIN_SPLIT_PARTS)} to ${String(MAX_PLAN_PARTS)})`,
      fix: example,
    });
  }
  return parts;
}

/** The subcommand's body: pure, so the workflow's matrix and this answer cannot disagree. */
export function verifyPlanCommand(args: ParsedArgs): CommandResult {
  const parts = readPlanParts(args);
  const plan = verifyPlan(parts);
  return {
    ok: true,
    command: 'verify plan',
    summary: msg('cli.verify.plan', { parts: plan.length, steps: VERIFY_STEP_NAMES.length }),
    data: { parts: plan.length, matrix: planMatrix(plan) },
    lines: plan.map(
      (part) =>
        `${part.part}  x verify --only ${part.only.join(',')}${part.shard === undefined ? '' : ` --shard ${part.shard}`}  (${part.needs})`,
    ),
  };
}
