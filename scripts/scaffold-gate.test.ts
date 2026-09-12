// The scaffold job ran `x verify` behind a `budgets` waiver and a fix-follow loop, so the question
// it answered was "can a scaffold be repaired into a gate?" — not the one a dz-runner box asks,
// which is `bin/setup && bin/check`, once, green. These pin that the replacement runs the app's own
// two scripts and that it has no allowance left to hide behind.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ExecResult } from '@ultimat3/cli';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { GateStep } from './reference-app-gate';
import { parseSteps } from './reference-app-gate';
import {
  appScript,
  CHECK_SCRIPT,
  MEASURED_STEPS,
  reproduce,
  reproduceSetup,
  runScaffoldGate,
  SETUP_SCRIPT,
  scaffoldFindings,
  setupFinding,
  stepTimings,
} from './scaffold-gate';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const step = (name: string, ok: boolean, skipped = false): GateStep => ({
  name,
  ok,
  skipped,
  findings: [],
});

const DIR = '/tmp/demoapp';

/**
 * The declared step set defaults to the names the table itself carries, so every assertion below
 * about red keeps asking ONLY about red. `declaredStepIssues` is the second rule and gets its own
 * describe: mixing it in here would make each of these tests fail for two reasons.
 */
const findingsFor = (
  steps: readonly GateStep[] | undefined,
  declaredSteps: readonly string[] = (steps ?? []).map((entry) => entry.name),
) => scaffoldFindings({ dir: DIR, steps, declaredSteps });

describe('unit · scaffoldFindings', () => {
  test('any red step fails the job, and the finding names every one of them', () => {
    const findings = findingsFor([
      step('typecheck', false),
      step('lint', false),
      step('unit', true),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('typecheck, lint');
    expect(findings[0]?.fix).toBe(`cd ${DIR} && ${SETUP_SCRIPT} && ${CHECK_SCRIPT} --json`);
  });

  /**
   * The whole point of the change. `budgets` was the one allowance CI granted, because `x verify`
   * weighs `.x/build-stats.json` and nothing wrote one — and there is no `--allow-red` to grant it
   * any more, so a table with `budgets` red is a failing job with no flag that can quiet it.
   */
  test('budgets red is a finding like any other — there is no allowance to pass', () => {
    const findings = findingsFor([step('budgets', false), step('lint', true)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('budgets');
  });

  test('a fully green table raises nothing', () => {
    expect(findingsFor([step('lint', true), step('budgets', true)])).toEqual([]);
  });

  /**
   * The hole a "not red" rule leaves open. `bin/check` spends a whole `x build --target static`
   * ahead of the gate so `budgets` has an artifact to weigh; a `budgets` that reports SKIPPED is
   * red on neither side of that rule and means the build measured nothing.
   */
  test('a measured step reporting skipped is a finding, not a pass', () => {
    expect(MEASURED_STEPS).toContain('budgets');
    const findings = findingsFor([step('lint', true), step('budgets', true, true)]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('skipped rather than green');
  });

  test('a skipped step that nothing measures is neither red nor a finding', () => {
    expect(findingsFor([step('lint', true), step('roadmap', true, true)])).toEqual([]);
  });

  test('no step table is the worst outcome, never a silent pass', () => {
    for (const steps of [undefined, []]) {
      const findings = findingsFor(steps, ['typecheck', 'lint']);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_SCAFFOLD_VERIFY_UNREADABLE');
      expect(findings[0]?.fix).toBe(reproduce(DIR));
    }
  });
});

/**
 * The hole this describe closes: every rule above reads the steps the table CONTAINS. A gate that
 * dies after step four prints four green steps and `redSteps` finds nothing red — so `scaffold-smoke`
 * reported "can a stranger scaffold an app that gates?" as yes on the strength of four steps of 20.
 */
describe('unit · a short table is a finding, not a green scaffold', () => {
  const DECLARED = ['typecheck', 'lint', 'unit', 'e2e'];

  test('a gate that crashed mid-run and printed two of its steps is reported', () => {
    const findings = findingsFor([step('typecheck', true), step('lint', true)], DECLARED);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('unit is declared but missing from the step table');
    expect(findings[0]?.cause).toContain('e2e is declared but missing');
    expect(findings[0]?.fix).toBe(reproduce(DIR));
  });

  test('a name nobody declares, and a name printed twice, are the other two shapes', () => {
    const invented = findingsFor(
      [...DECLARED.map((name) => step(name, true)), step('inventedStep', true)],
      DECLARED,
    );
    expect(invented[0]?.cause).toContain(
      'inventedStep is in the step table but not a declared step',
    );
    const twice = findingsFor(
      [...DECLARED.map((name) => step(name, true)), step('lint', true)],
      DECLARED,
    );
    expect(twice[0]?.cause).toContain('lint appears more than once');
  });

  test('the complete table stays silent, so the rule reports a gap and not a table', () => {
    expect(
      findingsFor(
        DECLARED.map((name) => step(name, true)),
        DECLARED,
      ),
    ).toEqual([]);
  });

  /**
   * The real call site passes `VERIFY_STEP_NAMES`, so the closed world above is not a different
   * rule from the shipped one. Without this, every test here could agree with a check the script
   * never performs.
   */
  test('and the shipped call is held to the real declared set', () => {
    const findings = findingsFor([step('lint', true)], VERIFY_STEP_NAMES);
    expect(findings[0]?.cause).toContain('is declared but missing from the step table');
    expect(VERIFY_STEP_NAMES.length).toBeGreaterThan(1);
  });

  /**
   * `budgets` is a declared step of the real gate, so the skip rule above is about the shipped
   * table and not about a name this file invented. A `MEASURED_STEPS` entry the gate never reports
   * would make that whole rule vacuous.
   */
  test('every measured step is a step the real gate declares', () => {
    // Widened deliberately: `VERIFY_STEP_NAMES` is a union of literals and `MEASURED_STEPS` is
    // `string[]`, so the comparison has to happen on the wider type or it cannot be written at all.
    const declared: readonly string[] = VERIFY_STEP_NAMES;
    for (const name of MEASURED_STEPS) expect(declared).toContain(name);
  });
});

describe('unit · the two scripts, and what they cost', () => {
  const table = (steps: string) => `{"ok":true,"steps":[${steps}]}`;
  const green = '{"name":"lint","ok":true,"skipped":false,"durationMs":81,"findings":[]}';

  const fakeExec = (
    calls: { command: readonly string[]; cwd: string }[],
    over: (command: readonly string[]) => Partial<ExecResult> = () => ({}),
  ) => {
    return async (command: readonly string[], options: { cwd: string }) => {
      calls.push({ command, cwd: options.cwd });
      return {
        command,
        code: 0,
        ok: true,
        stdout: '',
        stderr: '',
        durationMs: 7,
        ...over(command),
      } satisfies ExecResult;
    };
  };

  test('the app’s own bin/setup and bin/check run, in the app’s own directory, once each', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const run = await runScaffoldGate(
      DIR,
      fakeExec(calls, (command) =>
        command[0]?.endsWith(CHECK_SCRIPT) === true ? { stdout: table(green) } : {},
      ),
    );
    expect(calls.map((call) => call.command)).toEqual([
      [`${DIR}/${SETUP_SCRIPT}`],
      [`${DIR}/${CHECK_SCRIPT}`, '--json'],
    ]);
    expect(calls.every((call) => call.cwd === DIR)).toBe(true);
    expect(run.steps?.map((entry) => entry.name)).toEqual(['lint']);
  });

  /**
   * `bin/check` on an app whose database was never migrated reports a red table describing the
   * setup failure in steps that have nothing to do with it — so the failure is reported where it
   * happened, and the gate that cannot mean anything yet is not run at all.
   */
  test('a red bin/setup short-circuits the gate and is its own finding', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const run = await runScaffoldGate(
      DIR,
      fakeExec(calls, () => ({ ok: false, code: 1, stderr: 'X_BUN_MISSING: install bun' })),
    );
    expect(calls).toHaveLength(1);
    expect(run.setupOk).toBe(false);
    const finding = setupFinding(DIR, run.setupOutput);
    expect(finding.code).toBe('X_SCAFFOLD_FIRST_RUN_FAILED');
    expect(finding.cause).toContain('X_BUN_MISSING');
    expect(finding.fix).toBe(reproduceSetup(DIR));
  });

  // The PR body's table is this, and a timing of 0 for every step would look exactly like a
  // measurement nobody took.
  test('per-step wall time comes off the gate’s own json, beside both commands', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const run = await runScaffoldGate(
      DIR,
      fakeExec(calls, (command) =>
        command[0]?.endsWith(CHECK_SCRIPT) === true
          ? { stdout: `built static\n${table(green)}`, durationMs: 9770 }
          : { durationMs: 12051 },
      ),
    );
    expect(run.timings).toEqual([
      { name: SETUP_SCRIPT, ms: 12051, ok: true },
      { name: CHECK_SCRIPT, ms: 9770, ok: true },
      { name: 'lint', ms: 81, ok: true },
    ]);
  });

  test('stepTimings reads the LAST json line, which is the gate’s and not the build’s', () => {
    expect(stepTimings(`{"ok":true,"built":1}\n${table(green)}`)).toEqual([
      { name: 'lint', ms: 81, ok: true },
    ]);
    expect(stepTimings('no json here')).toEqual([]);
  });

  /**
   * One reader, two callers. `stepTimings` had its own copy of the line scan, the `JSON.parse`
   * guard and the array check, so "unreadable" was decided twice and the two were free to
   * disagree — a table the ratchet refused could still have produced a timings row, and the run
   * would have printed per-step milliseconds beside a finding saying no step's verdict was known.
   */
  test('the timings and the ratchet answer from the same parsed payload', () => {
    for (const unreadable of ['', 'no json here', '{ not json', '{"steps":"nope"}']) {
      expect(parseSteps(unreadable), unreadable).toBeUndefined();
      expect(stepTimings(unreadable), unreadable).toEqual([]);
    }
    const readable = `built static\n${table(green)}`;
    expect(parseSteps(readable)?.map((step) => step.name)).toEqual(
      stepTimings(readable).map((timing) => timing.name),
    );
  });

  /**
   * `x new --dir` accepts a relative path, and `exec` spawns with `cwd: dir` — so a relative
   * `bin/setup` is looked for at `demoapp/demoapp/bin/setup` and the gate dies on
   * X_CLI_UNEXPECTED instead of reporting a scaffold finding. Reported by review on #431.
   */
  test('a relative app directory still spawns an absolute script path', () => {
    expect(appScript('demoapp', SETUP_SCRIPT)).toBe(`${process.cwd()}/demoapp/${SETUP_SCRIPT}`);
    expect(appScript(DIR, CHECK_SCRIPT)).toBe(`${DIR}/${CHECK_SCRIPT}`);
  });
});

/**
 * The two commands this gate runs are the scaffold's, not this file's. If `templates/scaffold-docs.ts`
 * renames either one, CI would keep spawning a path `x new` no longer writes — and the job that
 * proves a bare VM can run them would be proving it against nothing.
 */
test('both scripts are paths the scaffold actually writes, pinned to the template', async () => {
  const template = await Bun.file(
    `${repoRoot()}/packages/cli/src/templates/scaffold-docs.ts`,
  ).text();
  const executables = template.match(/EXECUTABLE_FILES: readonly string\[\] = \[([^\]]+)\]/)?.[1];
  expect(
    executables,
    'templates/scaffold-docs.ts no longer declares EXECUTABLE_FILES',
  ).toBeDefined();
  for (const script of [SETUP_SCRIPT, CHECK_SCRIPT]) {
    expect(executables).toContain(`'${script}'`);
    expect(template).toContain(`{ path: '${script}', contents:`);
  }
});

/**
 * The waiver is gone, and this is what keeps it gone: `--allow-red` was a flag the workflow passed
 * and this script parsed, so either half surviving alone would be a silent re-opening.
 */
test('neither the workflow nor this script carries a --allow-red or a --fix-follow any more', async () => {
  const root = repoRoot();
  for (const path of ['.github/workflows/ci.yml', 'scripts/scaffold-gate.ts']) {
    const source = await Bun.file(`${root}/${path}`).text();
    expect(source, `${path} still passes or parses --allow-red`).not.toContain('--allow-red');
    expect(source, `${path} still passes or parses --fix-follow`).not.toContain('--fix-follow');
  }
});
