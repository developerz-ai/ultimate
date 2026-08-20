// Run a step list end to end and turn it into the one table every reader sees. Split from
// `cmd-verify.ts` because `x build` and the MCP host run the gate without going through the
// command: what a run means — never bail early, count what actually ran — belongs to neither.

import { renderThrowable } from '@ultimat3/core';
import { msg } from './messages';
import type { CommandResult, Finding, StepResult } from './output';
import {
  floorRequires,
  readVerifyFloor,
  skippedSuiteFinding,
  vanishedSuiteFinding,
} from './verify-floor';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';

/**
 * Run every step in order, never bailing early: an agent fixing three things at once needs all
 * three findings from one run, not one per round-trip.
 */
export async function runVerify(
  steps: readonly VerifyStep[],
  ctx: VerifyContext,
): Promise<CommandResult> {
  const floor = await readVerifyFloor(ctx.root);
  const results: StepResult[] = [];
  for (const step of steps) {
    const applies = step.applies === undefined ? true : await step.applies(ctx);
    if (!applies) {
      // A skip this repo already ruled out is not a skip. The step ran here before — the floor is
      // that claim, committed — so "nothing to check" now means the suite was deleted, and the
      // gate says so on the step's own line rather than counting one more thing not to worry
      // about. Recorded as failed and NOT as skipped, so every reader of a step table sees it:
      // the summary, `data.failed`, and the reference-app gate's own red list.
      const required = floorRequires(floor, step.name);
      results.push({
        name: step.name,
        ok: !required,
        durationMs: 0,
        skipped: !required,
        findings: required ? [vanishedSuiteFinding(step.name)] : [],
      });
      continue;
    }
    const started = performance.now();
    const outcome = await step.run(ctx).catch(
      (error: unknown): StepOutcome => ({
        ok: false,
        findings: [findingOf(error, step.name)],
      }),
    );
    // A step the floor requires whose suite executed nothing is the same vanished suite as a step
    // with no files at all — the run just had to finish before it could be seen. Appended to the
    // step's own findings so `data.failed`, the counts and every gate reading this table carry it.
    const vanished =
      floorRequires(floor, step.name) && outcome.tests !== undefined && outcome.tests.ran === 0
        ? [skippedSuiteFinding(step.name, outcome.tests.skipped)]
        : [];
    results.push({
      name: step.name,
      ok: outcome.ok && vanished.length === 0,
      durationMs: Math.round(performance.now() - started),
      findings: [...outcome.findings, ...vanished],
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
      ...(outcome.workers === undefined ? {} : { workers: outcome.workers }),
    });
  }
  const failedSteps = results.filter((step) => !step.ok).map((step) => step.name);
  const skippedSteps = results.filter((step) => step.skipped === true).map((step) => step.name);
  const totalMs = results.reduce((sum, step) => sum + step.durationMs, 0);
  return {
    ok: failedSteps.length === 0,
    command: 'verify',
    summary: verifySummary({ results, failed: failedSteps, skipped: skippedSteps, totalMs }),
    steps: results,
    // `skipped` is a list beside `failed` and not a count, because the two answer the same kind of
    // question — *which* steps, not how many — and a caller ratcheting on coverage needs the names.
    data: { failed: failedSteps, skipped: skippedSteps, durationMs: totalMs },
    exitCode: failedSteps.length === 0 ? 0 : 1,
  };
}

/**
 * What the counts are allowed to claim. A step that does not apply is recorded green so the run
 * continues, and the summary counted it among the "all 17 steps passed" — so a repo whose `job`
 * and `eval` suites do not exist reported the same line as a repo where both ran. `--json` carried
 * the per-step flag all along; the one line every reader actually sees did not, which is how a
 * vacuous gate stayed invisible. It names the skipped steps, not just how many: "17/17" is worth
 * something only when the gap is visible in the same glance.
 */
function verifySummary(input: {
  readonly results: readonly StepResult[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly totalMs: number;
}): string {
  const params = {
    count: input.results.length,
    passed: input.results.filter((step) => step.ok && step.skipped !== true).length,
    failed: input.failed.length,
    skipped: input.skipped.length,
    names: input.skipped.join(', '),
    ms: input.totalMs,
  };
  const clean = input.skipped.length === 0;
  if (input.failed.length === 0) {
    return msg(clean ? 'cli.verify.pass' : 'cli.verify.passSkipped', params);
  }
  return msg(clean ? 'cli.verify.fail' : 'cli.verify.failSkipped', params);
}

function findingOf(error: unknown, step: string): Finding {
  // A step may throw anything, including an Error that fights being read: `instanceof` runs a
  // Proxy's `getPrototypeOf` trap and `.message` runs a getter, so a hostile throw would take the
  // gate's own report down with it — the one message that may never be lost.
  const cause = renderThrowable(error);
  return {
    code: 'X_VERIFY_FAILED',
    cause: `step "${step}" threw: ${cause}`,
    fix: 'x verify --json',
    docs: 'https://ultimate.dev/errors/X_VERIFY_FAILED',
  };
}
