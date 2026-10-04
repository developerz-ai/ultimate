// Run a step list end to end and turn it into the one table every reader sees. Split from
// `cmd-verify.ts` because `x build` and the MCP host run the gate without going through the
// command: what a run means — never bail early, count what actually ran — belongs to neither.

import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import type { CoverageMap } from './coverage-lcov';
import { encodeCoverage } from './coverage-lcov';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue, StepResult } from './output';
import type { StepGuard } from './verify-deadline';
import { guardStep, raceDeadline, stepTimeoutMs } from './verify-deadline';
import {
  floorRequires,
  readVerifyFloor,
  skippedSuiteFinding,
  vanishedSuiteFinding,
} from './verify-floor';
import { stalledOutput, stepTimeoutFinding } from './verify-stalled';
import type {
  CoverageNumbers,
  StepOutcome,
  VerifyContext,
  VerifyStep,
  VerifyStepName,
} from './verify-step';
import { GATE_COMMAND } from './verify-step';

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
  // Per step: the numbers a judged run measured, or — under `--shard`, which cannot judge — the
  // `facts` its slice covered, for `x verify merge` to fold.
  const coverage = new Map<string, JsonValue>();
  // One per run: a step's tag is `<step>@<run>`, so two gates on one machine never kill each
  // other's children.
  const runId = crypto.randomUUID().slice(0, 8);
  const run = async (step: VerifyStep, stepCtx: VerifyContext): Promise<void> => {
    const ran = await runStep(step, stepCtx, floor, runId);
    byName.set(step.name, ran.result);
    if (ran.coverage !== undefined) {
      coverage.set(step.name, { facts: encodeCoverage(ran.coverage) });
    } else if (ran.measured !== undefined) {
      const { lines, funcs, files } = ran.measured;
      coverage.set(step.name, { lines, funcs, files });
    }
    // Told as it finishes, never at the end: the caller streams it, so a cancelled job's log
    // ends on the last step that finished (#589). A progress line is not the verdict: a listener
    // that throws — stderr closed under it — must not take the gate down with it.
    try {
      ctx.onStep?.(ran.result);
    } catch {
      // Nothing to report it on; the document on stdout still carries the step.
    }
  };
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
  // Isolation is the floor file's unless the caller said: absent in both is off (22.7).
  const base: VerifyContext =
    ctx.isolate === undefined && floor?.isolate !== undefined
      ? { ...ctx, isolate: floor.isolate }
      : ctx;
  // A parallel suite inside the overlap window used to be narrowed to one worker per core; the
  // default is at most that already (`test-workers.ts`), so the window runs the same plan.
  const shared: VerifyContext = base;
  for (const step of selected) {
    if (beside.includes(step)) continue;
    if (step.name === SERIAL_SUITES[0]) {
      pending = Promise.all(beside.map((other) => run(other, base))).then(() => undefined);
    } else if (!SERIAL_SUITES.includes(step.name)) {
      await join();
    }
    const inWindow = pending !== undefined && SERIAL_SUITES.includes(step.name);
    await run(step, inWindow ? shared : base);
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
      ...(coverage.size === 0 ? {} : { coverage: Object.fromEntries(coverage) }),
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
export function verifySummary(input: {
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
export const BESIDE_SERIAL_SUITES: ReadonlySet<VerifyStepName> = new Set<VerifyStepName>([
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
  'manifest',
]);

/** The consecutive run of steps the static group overlaps, in the order `VERIFY_STEP_NAMES` holds. */
export const SERIAL_SUITES: readonly VerifyStepName[] = ['live', 'job', 'e2e', 'eval'];

async function runStep(
  step: VerifyStep,
  ctx: VerifyContext,
  floor: Awaited<ReturnType<typeof readVerifyFloor>>,
  runId: string,
): Promise<{
  readonly result: StepResult;
  readonly coverage?: CoverageMap;
  readonly measured?: CoverageNumbers;
}> {
  const command = ctx.command ?? GATE_COMMAND;
  // Inside the step's own failure, like a throwing `run`: an `applies` that threw escaped every
  // catch and aborted the whole gate, which is the one outcome `runVerify` exists to prevent.
  let applies: boolean;
  try {
    applies = step.applies === undefined ? true : await step.applies(ctx);
  } catch (error) {
    return {
      result: {
        name: step.name,
        ok: false,
        durationMs: 0,
        findings: [findingOf(error, step.name, command)],
      },
    };
  }
  if (!applies) {
    // A skip this repo already ruled out is not a skip. The step ran here before — the floor is
    // that claim, committed — so "nothing to check" now means the suite was deleted, and the
    // gate says so on the step's own line rather than counting one more thing not to worry
    // about. Recorded as failed and NOT as skipped, so every reader of a step table sees it:
    // the summary, `data.failed`, and the reference-app gate's own red list.
    const required = floorRequires(floor, step.name);
    return {
      result: {
        name: step.name,
        ok: !required,
        durationMs: 0,
        skipped: !required,
        findings: required ? [vanishedSuiteFinding(step.name, command)] : [],
      },
    };
  }
  const started = performance.now();
  // The deadline: a step that hangs fails BY NAME and its processes are killed, instead of eating
  // the CI job's whole timeout and leaving a log that says nothing (#589). The step runs on a
  // guarded runner, so everything it starts carries its tag — that is what the kill finds.
  const limit = stepTimeoutMs(step.name, ctx.stepTimeoutMs, floor?.stepTimeoutMs);
  const guard = guardStep(ctx.runner, `${step.name}@${runId}`);
  const raced = await raceDeadline(
    step.run({ ...ctx, runner: guard.runner }).catch(
      (error: unknown): StepOutcome => ({
        ok: false,
        findings: [findingOf(error, step.name, command)],
      }),
    ),
    limit,
  );
  const outcome: StepOutcome = raced.timedOut
    ? await expired(step.name, limit, guard, command)
    : raced.value;
  // A suite that executed nothing did not run, whatever its exit code says: `bun test` exits 0
  // over an all-skipped file, so the counts are the only channel that can tell the two apart.
  // ONE definition of "nothing ran", read twice, because the floor decides which of the two
  // things it means — exactly as it already does for a step whose `applies` said no.
  const tests = outcome.tests;
  // A shard's slice may hold nothing, or only skipped tests, and still be a correct slice: the
  // "did the suite run at all" question is asked by `x verify merge`, on the summed counts.
  const nothingRan = tests !== undefined && tests.ran === 0 && outcome.shard === undefined;
  const required = floorRequires(floor, step.name);
  // A step the floor requires whose suite executed nothing is the same vanished suite as a step
  // with no files at all — the run just had to finish before it could be seen. Appended to the
  // step's own findings so `data.failed`, the counts and every gate reading this table carry it.
  const vanished = nothingRan && required ? [skippedSuiteFinding(step.name, tests.skipped)] : [];
  return {
    result: {
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
      ...(outcome.widthReason === undefined ? {} : { widthReason: outcome.widthReason }),
      ...(outcome.shard === undefined ? {} : { shard: outcome.shard }),
      ...(tests === undefined ? {} : { tests }),
    },
    ...(outcome.coverage === undefined ? {} : { coverage: outcome.coverage }),
    ...(outcome.measured === undefined ? {} : { measured: outcome.measured }),
  };
}

/** The timed-out step's outcome: the finding naming what was in flight, over what it last printed. */
async function expired(
  step: VerifyStepName,
  limit: number,
  guard: StepGuard,
  command: string,
): Promise<StepOutcome> {
  const expiry = await guard.expire();
  const output = stalledOutput(expiry);
  return {
    ok: false,
    findings: [stepTimeoutFinding(step, limit, expiry, command)],
    ...(output === undefined ? {} : { output }),
  };
}

function findingOf(error: unknown, step: string, command: string): Finding {
  // A step may throw anything, including an Error that fights being read: `instanceof` runs a
  // Proxy's `getPrototypeOf` trap and `.message` runs a getter, so a hostile throw would take the
  // gate's own report down with it — the one message that may never be lost.
  const cause = renderThrowable(error);
  return {
    code: 'X_VERIFY_FAILED',
    cause: `step "${step}" threw: ${cause}`,
    fix: `${command} --json`,
    docs: ERROR_DOCS_URL,
  };
}
