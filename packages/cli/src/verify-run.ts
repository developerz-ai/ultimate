// Run a step list end to end and turn it into the one table every reader sees. Split from
// `cmd-verify.ts` because `x build` and the MCP host run the gate without going through the
// command: what a run means — never bail early, count what actually ran — belongs to neither.

import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import { msg } from './messages';
import type { CommandResult, Finding, StepResult } from './output';
import { sharedWorkers } from './test-workers';
import {
  floorRequires,
  readVerifyFloor,
  skippedSuiteFinding,
  vanishedSuiteFinding,
} from './verify-floor';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';

/**
 * Run every step, never bailing early: an agent fixing three things at once needs all
 * three findings from one run, not one per round-trip.
 *
 * `ctx.only` narrows the list to the steps it names, kept in declared order. The narrowing lives
 * HERE rather than in `cmd-verify.ts` so that every caller of the runner — the command, `x build`,
 * the MCP host — gets the banner and the `--json` flag with it, instead of one of them filtering a
 * list quietly.
 */
export async function runVerify(
  steps: readonly VerifyStep[],
  ctx: VerifyContext,
): Promise<CommandResult> {
  const floor = await readVerifyFloor(ctx.root);
  const only = onlyList(ctx.only);
  const selected = only === undefined ? steps : steps.filter((step) => only.includes(step.name));
  const byName = new Map<string, StepResult>();
  const began = performance.now();
  // The static steps wait for the serial suites and then run BESIDE them — only when `live` is in
  // the list, so a one-step run (`--only`) and a list with no serial suite keep today's order.
  const overlapping = selected.some((step) => step.name === SERIAL_SUITES[0]);
  const beside = overlapping ? selected.filter((step) => BESIDE_SERIAL_SUITES.has(step.name)) : [];
  let pending: Promise<void> | undefined;
  const join = async (): Promise<void> => {
    await pending;
    pending = undefined;
  };
  // A parallel suite inside that window shares the cores with the static group, so its DEFAULT
  // width is one per core (`sharedWorkers`); an explicit `--workers` is the caller's and stands.
  const shared: VerifyContext =
    ctx.workers === undefined && beside.length > 0 ? { ...ctx, workers: sharedWorkers() } : ctx;
  for (const step of selected) {
    if (beside.includes(step)) continue;
    if (step.name === SERIAL_SUITES[0]) {
      pending = Promise.all(
        beside.map(async (other) => {
          byName.set(other.name, await runStep(other, ctx, floor));
        }),
      ).then(() => undefined);
    } else if (!SERIAL_SUITES.includes(step.name)) {
      await join();
    }
    const inWindow = pending !== undefined && SERIAL_SUITES.includes(step.name);
    byName.set(step.name, await runStep(step, inWindow ? shared : ctx, floor));
  }
  await join();
  // Reported in the declared order, whatever order the steps finished in: the table, `--json` and
  // every gate parsing either read the same sequence they always did.
  const results = selected.flatMap((step) => {
    const result = byName.get(step.name);
    return result === undefined ? [] : [result];
  });
  const failedSteps = results.filter((step) => !step.ok).map((step) => step.name);
  const skippedSteps = results.filter((step) => step.skipped === true).map((step) => step.name);
  // WALL time, not the sum of step times: with steps overlapping, the sum overstates what a run
  // costs, and the wall clock is the number a CI job waits on.
  const totalMs = Math.round(performance.now() - began);
  const summary = verifySummary({
    results,
    failed: failedSteps,
    skipped: skippedSteps,
    totalMs,
  });
  return {
    ok: failedSteps.length === 0,
    command: 'verify',
    // Rendered through the catalog like every other summary this file emits; the machine marker
    // is `data.notAGateRun` below. It was a bare `NOT A GATE RUN` constant, which put one
    // user-facing string outside `messages.ts` for a fact `--json` was already carrying twice.
    summary: only === undefined ? summary : msg('cli.verify.notAGateRun', { summary }),
    steps: results,
    // `skipped` is a list beside `failed` and not a count, because the two answer the same kind of
    // question — *which* steps, not how many — and a caller ratcheting on coverage needs the names.
    data: {
      failed: failedSteps,
      skipped: skippedSteps,
      durationMs: totalMs,
      // A BOOLEAN beside the banner, so a reader of `--json` never has to substring-match a
      // summary line to learn that this run checked one thing.
      // `only` is always the LIST, in declared order — one name is a list of one.
      ...(only === undefined ? {} : { notAGateRun: true, only: [...only] }),
    },
    // The step's own status: one step, so `failedSteps` is that step and nothing else.
    exitCode: failedSteps.length === 0 ? 0 : 1,
  };
}

/** One name or several, as one list — the context accepts both, every reader here wants a list. */
const onlyList = (only: VerifyContext['only']): readonly string[] | undefined =>
  only === undefined ? undefined : typeof only === 'string' ? [only] : only;

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

/**
 * `x verify`'s wall time was the SUM of 20 serial steps (#14, the DX ledger): measured locally, 395s,
 * of which `lint`, `boundaries`, `filesize`, `package-shape` and `errors` were 127s spent while
 * nothing else ran. They read the tree and write nothing a later step reads (`lint` is biome over
 * files; the rest are in-process scans), so they run BESIDE the serial suites — `live` and `e2e`
 * are one worker each, Postgres- and browser-bound, and mostly waiting. `typecheck` stays first
 * and alone: `tsc -b` writes `.tsbuildinfo` and `dist/`, and `unit` saturates every core.
 * `manifest` joined them 2026-09-23: it compares committed files against the code and writes
 * nothing, and at the repo root its host checks are ~20 whole-tree reads that sat alone at the end.
 */
export const BESIDE_SERIAL_SUITES: ReadonlySet<string> = new Set([
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
  'manifest',
]);

/** The consecutive run of steps the static group overlaps, in the order `VERIFY_STEP_NAMES` holds. */
export const SERIAL_SUITES: readonly string[] = ['live', 'job', 'e2e', 'eval'];

async function runStep(
  step: VerifyStep,
  ctx: VerifyContext,
  floor: Awaited<ReturnType<typeof readVerifyFloor>>,
): Promise<StepResult> {
  // Inside the step's own failure, like a throwing `run`: an `applies` that threw escaped every
  // catch and aborted the whole gate, which is the one outcome `runVerify` exists to prevent.
  let applies: boolean;
  try {
    applies = step.applies === undefined ? true : await step.applies(ctx);
  } catch (error) {
    return { name: step.name, ok: false, durationMs: 0, findings: [findingOf(error, step.name)] };
  }
  if (!applies) {
    // A skip this repo already ruled out is not a skip. The step ran here before — the floor is
    // that claim, committed — so "nothing to check" now means the suite was deleted, and the
    // gate says so on the step's own line rather than counting one more thing not to worry
    // about. Recorded as failed and NOT as skipped, so every reader of a step table sees it:
    // the summary, `data.failed`, and the reference-app gate's own red list.
    const required = floorRequires(floor, step.name);
    return {
      name: step.name,
      ok: !required,
      durationMs: 0,
      skipped: !required,
      findings: required ? [vanishedSuiteFinding(step.name)] : [],
    };
  }
  const started = performance.now();
  const outcome = await step.run(ctx).catch(
    (error: unknown): StepOutcome => ({
      ok: false,
      findings: [findingOf(error, step.name)],
    }),
  );
  // A suite that executed nothing did not run, whatever its exit code says: `bun test` exits 0
  // over an all-skipped file, so the counts are the only channel that can tell the two apart.
  // ONE definition of "nothing ran", read twice, because the floor decides which of the two
  // things it means — exactly as it already does for a step whose `applies` said no.
  const tests = outcome.tests;
  const nothingRan = tests !== undefined && tests.ran === 0;
  const required = floorRequires(floor, step.name);
  // A step the floor requires whose suite executed nothing is the same vanished suite as a step
  // with no files at all — the run just had to finish before it could be seen. Appended to the
  // step's own findings so `data.failed`, the counts and every gate reading this table carry it.
  const vanished = nothingRan && required ? [skippedSuiteFinding(step.name, tests.skipped)] : [];
  return {
    name: step.name,
    ok: outcome.ok && vanished.length === 0,
    durationMs: Math.round(performance.now() - started),
    // Without a floor to require it, a suite that ran nothing is a SKIP and not a pass (#434):
    // the `e2e` step printed `✓ e2e 46ms` over its one skipped test, which is the one thing a
    // step table may never do — a reader cannot tell a lane that ran from a lane that did not.
    skipped: nothingRan && !required,
    findings: [...outcome.findings, ...vanished],
    ...(outcome.output === undefined ? {} : { output: outcome.output }),
    ...(outcome.workers === undefined ? {} : { workers: outcome.workers }),
    ...(tests === undefined ? {} : { tests }),
  };
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
    docs: ERROR_DOCS_URL,
  };
}
