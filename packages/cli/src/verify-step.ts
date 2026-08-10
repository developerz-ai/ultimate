// The shape of one gate step: its name, what it checks, whether it applies here, and how a host
// repo feeds it findings it could not produce on its own. Split from the step list so a step
// implementation can live beside the code it checks without importing the list.

import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';

/**
 * Every step of the gate, in cost order — cheapest and most informative first, and never a check
 * whose result would be meaningless because an earlier one failed. This list is the definition of
 * shippable: the framework repo and a generated app run exactly it, whole, or not at all.
 */
export const VERIFY_STEP_NAMES = [
  'typecheck',
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
  'unit',
  'contract',
  'live',
  'job',
  'e2e',
  'eval',
  'drift',
  'contract-diff',
  'budgets',
  'manifest',
] as const;

export type VerifyStepName = (typeof VERIFY_STEP_NAMES)[number];

/**
 * A rule the host repo enforces inside an existing step — the framework monorepo's package tier
 * table under `boundaries`, its generated manifest under `manifest`. A host adds findings to a
 * step; it can never add, remove, reorder or skip one.
 */
export type HostCheck = (root: string) => Promise<readonly Finding[]>;

export interface VerifyContext {
  readonly root: string;
  readonly runner: Runner;
  readonly hostChecks?: Partial<Record<VerifyStepName, HostCheck>>;
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly output?: string;
}

export interface VerifyStep {
  readonly name: VerifyStepName;
  readonly summary: string;
  /** Returns false to record the step as skipped rather than passed. */
  applies?(ctx: VerifyContext): Promise<boolean>;
  run(ctx: VerifyContext): Promise<StepOutcome>;
}

export const passed: StepOutcome = { ok: true, findings: [] };

export function fromExec(result: ExecResult, finding: Omit<Finding, 'docs'>): StepOutcome {
  if (result.ok) return { ok: true, findings: [], output: execOutput(result) };
  return {
    ok: false,
    findings: [{ ...finding, docs: `https://ultimate.dev/errors/${finding.code}` }],
    output: execOutput(result),
  };
}

export const fromFindings = (findings: readonly Finding[]): StepOutcome => ({
  ok: findings.length === 0,
  findings,
});

/** What the host repo contributes to this step, or nothing. */
export const hostFindings = async (
  ctx: VerifyContext,
  step: VerifyStepName,
): Promise<readonly Finding[]> => (await ctx.hostChecks?.[step]?.(ctx.root)) ?? [];
