// The scaffold job's `x verify` carried `continue-on-error: true`, so every one of its 17 steps
// was advisory over a waiver written for one of them. These pin that the replacement fails in both
// directions and that it drives the app's own `verify` script rather than a copy of the gate.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ExecResult } from '@ultimat3/cli';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { flagList, parseScriptArgs } from './lib/args';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { GateStep } from './reference-app-gate';
import { reproduce, runScaffoldGate, scaffoldFindings, WAIVER_FILE } from './scaffold-gate';

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
 * about red/stale keeps asking ONLY about red and stale. `declaredStepIssues` is the third rule and
 * gets its own describe: mixing it in here would make each of these tests fail for two reasons.
 */
const findingsFor = (
  steps: readonly GateStep[] | undefined,
  allowRed: readonly string[],
  declaredSteps: readonly string[] = (steps ?? []).map((entry) => entry.name),
) => scaffoldFindings({ dir: DIR, steps, allowRed, declaredSteps });

describe('unit · scaffoldFindings', () => {
  test('a red step nobody allowed fails the job, and names the step', () => {
    const steps = [step('typecheck', false), step('lint', false), step('unit', true)];
    const findings = findingsFor(steps, ['typecheck']);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('lint');
    expect(findings[0]?.cause).not.toContain('typecheck');
    expect(findings[0]?.fix).toBe(`cd ${DIR} && bun run verify --json`);
  });

  test('the allowed step failing on its own is the passing case', () => {
    const steps = [step('typecheck', false), step('lint', true), step('e2e', true, true)];
    expect(findingsFor(steps, ['typecheck'])).toEqual([]);
  });

  /**
   * The other direction. The waiver exists for one pinned TS18048 gap in `x new --example`'s
   * `entity.ts`; the day that closes, a waiver nothing forces down is a waiver that keeps excusing
   * whatever lands behind it — which is exactly how it came to cover all 17 steps.
   */
  test('an allowed step that has started passing is a waiver to delete', () => {
    const steps = [step('typecheck', true), step('lint', true)];
    const findings = findingsFor(steps, ['typecheck']);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.fix).toBe(
      `drop --allow-red typecheck from the scaffold-smoke verify step in ${WAIVER_FILE}`,
    );
    expect(findings[0]?.at).toBe(WAIVER_FILE);
  });

  test('a green gate with no waiver at all raises nothing', () => {
    expect(findingsFor([step('lint', true)], [])).toEqual([]);
  });

  test('no step table is the worst outcome, never a silent pass', () => {
    for (const steps of [undefined, []]) {
      const findings = findingsFor(steps, ['typecheck'], ['typecheck', 'lint']);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_SCAFFOLD_GATE_RED');
      expect(findings[0]?.fix).toBe(reproduce(DIR));
    }
  });

  test('a skipped step is not red, so it neither fails the job nor satisfies a waiver', () => {
    const steps = [step('typecheck', false), step('e2e', true, true)];
    expect(findingsFor(steps, ['typecheck'])).toEqual([]);
    const findings = findingsFor(steps, ['typecheck', 'e2e']);
    expect(findings[0]?.cause).toContain('e2e');
  });
});

/**
 * The hole this describe closes, and it is the one the whole file was written around: every rule
 * above reads the steps the table CONTAINS. A gate that dies after step four prints four green
 * steps, and `redSteps` finds nothing red, and `allowRed` is empty — so `scaffold-smoke` reported
 * "can a stranger scaffold an app that gates?" as yes on the strength of four steps out of 19.
 */
describe('unit · a short table is a finding, not a green scaffold', () => {
  const DECLARED = ['typecheck', 'lint', 'unit', 'e2e'];

  test('a gate that crashed mid-run and printed four of its steps is reported', () => {
    const steps = [step('typecheck', true), step('lint', true)];
    const findings = findingsFor(steps, [], DECLARED);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('unit is declared but missing from the step table');
    expect(findings[0]?.cause).toContain('e2e is declared but missing');
    expect(findings[0]?.fix).toBe(reproduce(DIR));
  });

  test('a name nobody declares, and a name printed twice, are the other two shapes', () => {
    const invented = findingsFor(
      [...DECLARED.map((name) => step(name, true)), step('inventedStep', true)],
      [],
      DECLARED,
    );
    expect(invented[0]?.cause).toContain(
      'inventedStep is in the step table but not a declared step',
    );
    const twice = findingsFor(
      [...DECLARED.map((name) => step(name, true)), step('lint', true)],
      [],
      DECLARED,
    );
    expect(twice[0]?.cause).toContain('lint appears more than once');
  });

  test('the complete table stays silent, so the rule reports a gap and not a table', () => {
    expect(
      findingsFor(
        DECLARED.map((name) => step(name, true)),
        [],
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
    const findings = findingsFor([step('lint', true)], [], VERIFY_STEP_NAMES);
    expect(findings[0]?.cause).toContain('is declared but missing from the step table');
    expect(VERIFY_STEP_NAMES.length).toBeGreaterThan(1);
  });
});

describe('unit · the waiver flag and the subprocess', () => {
  // The invocation `.github/workflows/ci.yml` carries, parsed by the same parser the script uses.
  test('--allow-red takes a comma list beside the app directory, and absent allows nothing', () => {
    const args = parseScriptArgs([DIR, '--allow-red', 'typecheck,lint']);
    expect(args.positionals).toEqual([DIR]);
    expect(flagList(args, 'allow-red')).toEqual(['typecheck', 'lint']);
    expect(flagList(parseScriptArgs([DIR]), 'allow-red')).toEqual([]);
  });

  /**
   * The defect this file's own error had: `--allow-red typecheck` was the example in the usage line
   * AND inside `X_SCAFFOLD_GATE_RED`'s `fix:`, and `typecheck` passes in a scaffolded app now — so
   * an agent pasting the fix verbatim got an instant `stale` finding for a step already green. A
   * fix line is pasted, not read, so an example that has stopped working is a wrong instruction.
   *
   * The `stale` rule makes the ALLOWANCE shrink on its own; nothing made the EXAMPLE follow it.
   * This is that, and it reads both sites at once by scanning this script's own source.
   */
  test('every --allow-red example in the script names a step the CI ratchet still allows', async () => {
    // `repoRoot()`, not `${import.meta.dir}/..` — one way to find the root, and it does not drift
    // the day this file moves.
    const root = repoRoot();
    const workflow = await Bun.file(`${root}/${WAIVER_FILE}`).text();
    const allowed = new Set(
      [...workflow.matchAll(/--allow-red\s+([\w,]+)/g)].flatMap((match) =>
        (match[1] ?? '').split(','),
      ),
    );
    // A parser that found nothing would make the assertion below vacuously true.
    expect(allowed.size).toBeGreaterThan(0);

    const source = await Bun.file(`${root}/scripts/scaffold-gate.ts`).text();
    const examples = [...source.matchAll(/--allow-red\s+([\w,]+)/g)].flatMap((match) =>
      (match[1] ?? '').split(','),
    );
    expect(examples.length).toBeGreaterThan(1);
    for (const example of examples) {
      expect(allowed, `--allow-red ${example} is an example that would report stale`).toContain(
        example,
      );
    }
  });

  test('the app’s own verify script is what runs, in the app’s own directory', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const fake = async (command: readonly string[], options: { cwd: string }) => {
      calls.push({ command, cwd: options.cwd });
      return {
        command,
        code: 1,
        ok: false,
        stdout: '{"steps":[{"name":"lint","ok":false,"skipped":false,"findings":[]}]}',
        stderr: '',
        durationMs: 0,
      } satisfies ExecResult;
    };
    expect((await runScaffoldGate(DIR, fake))?.map((entry) => entry.name)).toEqual(['lint']);
    expect(calls[0]?.command).toEqual(['bun', 'run', 'verify', '--json']);
    expect(calls[0]?.cwd).toBe(DIR);
  });
});
