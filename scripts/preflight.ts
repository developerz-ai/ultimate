#!/usr/bin/env bun
// The one command a worker runs before reporting: for the units this checkout changed since it
// left `origin/main`, the cheap ratchets, coverage per touched unit and the serve-graph test when
// a source file moved — one verdict. Per-package coverage broken by a worker used to surface only
// in CI's `packages (n/3)` (create-ultimate at 94.44%, sweep 6); this asks the same question first.
//
//   bun run preflight [<path>…] [--json]
//
// Paths narrow the diff to what they prefix: a worker in a shared checkout names its own file set,
// and the units its teammates touched are neither run nor counted.

import { withHeavy } from '../packages/cli/src/heavy';
import { LOCAL_CORE_CAP } from '../packages/cli/src/heavy-cores';
import { TEST_RUN_BASE_MB, TEST_WORKER_PEAK_MB } from '../packages/cli/src/heavy-weights';
import { parseScriptArgs } from './lib/args';
import { changedSinceBase } from './lib/changed-files';
import { unreleasedCheck } from './lib/changelog-unreleased-git';
import { unitsToGate } from './lib/coverage-units';
import type { Finding } from './lib/log';
import { renderFinding, report } from './lib/log';
import type { RunResult } from './lib/run';
import { DEFAULT_RUN_TIMEOUT_MS, LONG_RUN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { ScriptError } from './lib/script-error';
import { stopTreeOnSignal } from './lib/stop-tree';
import type { PreflightStep } from './preflight-plan';
import { isOurs, movedSource, preflightSteps, touchedUnits } from './preflight-plan';

const SCRIPT = 'preflight';
/** Cheap steps at once: each is one whole-tree scan, and more than this only queues on the cores. */
const CHEAP_AT_ONCE = 4;

export type StepRunner = (
  command: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<RunResult>;

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly findings: readonly Finding[];
}

const isFinding = (value: unknown): value is Finding =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'code') === 'string' &&
  typeof Reflect.get(value, 'cause') === 'string' &&
  typeof Reflect.get(value, 'fix') === 'string';

/** A script's one JSON document, found among whatever else its stderr said. */
export function scriptDocument(output: string): { ok: boolean; findings: Finding[] } | undefined {
  const line = output.split('\n').find((candidate) => candidate.startsWith('{"ok":'));
  if (line === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const ok: unknown = Reflect.get(parsed, 'ok');
    const findings: unknown = Reflect.get(parsed, 'findings');
    if (typeof ok !== 'boolean') return undefined;
    return { ok, findings: Array.isArray(findings) ? findings.filter(isFinding) : [] };
  } catch {
    return undefined;
  }
}

/** A step that answered no document still answers: a finding with nowhere to point, so it counts. */
const silent = (step: PreflightStep, result: RunResult): Finding => {
  const cause = `${step.name} exited ${String(result.code)} with no verdict document: ${result.output.split('\n').slice(-3).join(' / ').slice(0, 300)}`;
  const fix = step.command.filter((word) => word !== '--json').join(' ');
  // One literal per code: the declaration scan reads `code: '…'`, never a ternary's branches.
  if (result.timedOut) return { code: 'X_SPAWN_TIMED_OUT', cause, fix };
  return { code: 'X_PREFLIGHT_STEP_FAILED', cause, fix };
};

export async function runStep(
  root: string,
  step: PreflightStep,
  runner: StepRunner = run,
): Promise<StepResult> {
  const timeoutMs = step.heavy ? LONG_RUN_TIMEOUT_MS : DEFAULT_RUN_TIMEOUT_MS;
  // A heavy step is one reservation; the coverage gate it starts inherits it instead of queueing.
  const result = step.heavy
    ? await withHeavy(
        {
          label: `preflight ${step.name}`,
          cwd: root,
          env: Bun.env,
          unitMb: TEST_WORKER_PEAK_MB,
          baseMb: TEST_RUN_BASE_MB,
          units: LOCAL_CORE_CAP,
          minUnits: 1,
        },
        (child) =>
          runner(step.command, {
            cwd: root,
            timeoutMs,
            // `run` takes a whole environment, so the hold is laid over this process's.
            ...(Object.keys(child.env).length === 0 && child.fds.length === 0
              ? {}
              : { env: { ...Bun.env, ...child.env }, inheritFds: child.fds }),
          }),
      )
    : await runner(step.command, { cwd: root, timeoutMs });
  if (step.kind === 'test') {
    return {
      name: step.name,
      ok: result.ok,
      ms: result.durationMs,
      findings: result.ok ? [] : [silent(step, result)],
    };
  }
  const document = scriptDocument(result.output);
  if (document === undefined) {
    return { name: step.name, ok: false, ms: result.durationMs, findings: [silent(step, result)] };
  }
  const findings =
    document.ok || document.findings.length > 0 ? document.findings : [silent(step, result)];
  return { name: step.name, ok: document.ok, ms: result.durationMs, findings };
}

export interface Preflight {
  readonly ok: boolean;
  readonly base: string | undefined;
  readonly touched: readonly string[];
  readonly steps: readonly StepResult[];
  /** The findings that decide the verdict: in a changed file or a touched unit. */
  readonly ours: readonly Finding[];
  /** Red elsewhere in a shared checkout: printed, never counted. */
  readonly elsewhere: readonly Finding[];
  readonly notices: readonly Finding[];
}

export async function preflight(
  root: string,
  runner: StepRunner = run,
  scope: readonly string[] = [],
): Promise<Preflight> {
  const whole = await changedSinceBase(root);
  const inScope = (path: string): boolean =>
    scope.length === 0 ||
    scope.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`));
  const diff = {
    ...whole,
    changed: whole.changed.filter(inScope),
    added: whole.added.filter(inScope),
  };
  if (diff.base === undefined) {
    const missing: Finding = {
      code: 'X_PREFLIGHT_BASE_MISSING',
      cause: 'this checkout has no origin/main, so preflight cannot tell which units it changed',
      fix: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main   # then: bun run preflight',
    };
    return {
      ok: false,
      base: undefined,
      touched: [],
      steps: [],
      ours: [missing],
      elsewhere: [],
      notices: [],
    };
  }
  const touched = touchedUnits(diff.changed, unitsToGate(root));
  const present = new Set<string>();
  for (const path of diff.changed)
    if (await Bun.file(`${root}/${path}`).exists()) present.add(path);
  const moved = movedSource(diff.changed, diff.added, (path) => present.has(path));
  const steps = preflightSteps({ touched, moved });
  const cheap = steps.filter((step) => !step.heavy);
  const results: StepResult[] = [];
  for (let at = 0; at < cheap.length; at += CHEAP_AT_ONCE) {
    const batch = cheap.slice(at, at + CHEAP_AT_ONCE);
    results.push(...(await Promise.all(batch.map((step) => runStep(root, step, runner)))));
  }
  for (const step of steps.filter((one) => one.heavy))
    results.push(await runStep(root, step, runner));
  const all = results.flatMap((result) => result.findings);
  const ours = all.filter((finding) => isOurs(finding, touched, diff.changed));
  const unreleased = await unreleasedCheck(root, {});
  return {
    ok: ours.length === 0,
    base: diff.base,
    touched,
    steps: results,
    ours,
    elsewhere: all.filter((finding) => !ours.includes(finding)),
    notices: unreleased.finding === undefined ? [] : [unreleased.finding],
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

if (import.meta.main) {
  // Stopped, it stops the suites it started: an orphan kept the ledger reservation it inherited.
  stopTreeOnSignal('preflight');
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: [],
    refuse: (unknown) =>
      new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')} — preflight takes --json alone`,
        fix: 'bun run preflight --json',
      }),
  });
  const result = await preflight(repoRoot(), run, args.positionals);
  const lines = [
    `touched: ${result.touched.join(', ') || 'no unit'} (since ${result.base ?? 'no base'})`,
    ...result.steps.map((step) => `${step.ok ? '✓' : '✗'} ${step.name} ${seconds(step.ms)}`),
    ...result.elsewhere.map((finding) => `elsewhere, not counted:\n${renderFinding(finding)}`),
    ...result.notices.map((finding) => `notice, not counted:\n${renderFinding(finding)}`),
  ];
  const total = result.steps.reduce((sum, step) => sum + step.ms, 0);
  report(
    {
      ok: result.ok,
      script: SCRIPT,
      summary: result.ok
        ? `preflight green: ${String(result.steps.length)} step(s) over ${String(result.touched.length)} touched unit(s), ${seconds(total)} of step time`
        : `preflight red: ${String(result.ours.length)} finding(s) in what this checkout changed`,
      findings: result.ours,
      lines,
      data: result,
    },
    args.json,
  );
}
