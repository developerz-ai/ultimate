// The shape of one gate step: its name, what it checks, whether it applies here, and how a host
// repo feeds it findings it could not produce on its own. Split from the step list so a step
// implementation can live beside the code it checks without importing the list.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';
import type { TestCounts } from './test-counts';

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
  // Eighteenth, and a deliberate widening of a closed list rather than a `HostCheck`: an SEO gate
  // is a MECHANISM every app with a `site/` surface wants (axiom 8), not a rule one host repo
  // enforces — and `verifyCommand.run` passes no host checks at all, so the app path could not
  // have carried it. It runs beside `budgets` because both read the app the same load produced.
  'seo',
  // Nineteenth, by the same test the SEO step above passed and for the same reason it is not a
  // rider: `boundaries` asks whether an import was LEGAL and this asks whether a declaration
  // REACHED the running app, which is a different question with a different fix (axiom 4). It
  // costs no second app load — `budgets` already imported every module, and this reads the
  // registries that load filled. Until it existed, an app could ship every user-facing string as
  // `⟦key⟧` with `x verify` green, because nothing in the gate ever asked (issue #249).
  'i18n',
  // Twentieth, by the same test `seo` and `i18n` each passed: a rider must ask the SAME question
  // off the same data, and "was this import legal?" is not "does the permission this app grants
  // and requires exist?". Reported under `budgets` it would hand the reader a byte budget for an
  // authz defect (axiom 4). Until it existed, `x new` shipped an app that answered HTTP 500 with
  // X_PERMISSION_UNKNOWN on two of its three routes under a green gate: `defineRoles()` accepts an
  // undeclared grant in silence and `RouteGuard.permission` is a bare string. It costs no second
  // app load — `budgets` already imported every module, and this reads the registries that filled.
  'policy',
  'manifest',
  'roadmap',
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
  /**
   * How wide the parallel test steps go. Absent means `defaultWorkers()` — a knob, never a
   * narrowing: no value of it changes which steps run or what "green" means.
   */
  readonly workers?: number;
  /**
   * ONE step, by name — an iteration loop, and the one thing here that IS a narrowing. Every
   * iteration of the whole gate costs ~18s (14s of it `tsc -b`), which is the cost of asking a
   * question about one step. It does not weaken axiom 5, and the two rules that keep it honest are
   * mechanical rather than remembered: a run with this set prints `NOT A GATE RUN` in the summary
   * AND carries `notAGateRun` in `--json` (`verify-run.ts`), so no reader of either can mistake it
   * for the gate; and nothing writes `x.verify.json`, so the suite floor cannot be lowered by a
   * run that never executed the suites. Green still means the no-flag run, unchanged.
   */
  readonly only?: VerifyStepName;
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly output?: string;
  /**
   * Processes this step actually used. `1` is a step that ran serially, and a reader has to be
   * able to tell "serial because nothing could isolate it" from "parallel and fast" without
   * reading the step list's source.
   */
  readonly workers?: number;
  /**
   * What the suite executed, for the steps that run one. Absent means this step spawned no test
   * process at all — a check step, or the `eval` step answering with declarations alone — and is
   * NOT the same as a suite that ran nothing, which is a number the ratchet acts on.
   */
  readonly tests?: TestCounts;
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
    findings: [{ ...finding, docs: ERROR_DOCS_URL }],
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
