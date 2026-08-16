// The scaffold job's `x verify` carried `continue-on-error: true`, so every one of its 17 steps
// was advisory over a waiver written for one of them. These pin that the replacement fails in both
// directions and that it drives the app's own `verify` script rather than a copy of the gate.

import { describe, expect, test } from 'bun:test';
import type { ExecResult } from '@ultimat3/cli';
import { flagList, parseScriptArgs } from './lib/args';
import type { GateStep } from './reference-app-gate';
import { reproduce, runScaffoldGate, scaffoldFindings, WAIVER_FILE } from './scaffold-gate';

const step = (name: string, ok: boolean, skipped = false): GateStep => ({
  name,
  ok,
  skipped,
  findings: [],
});

const DIR = '/tmp/demoapp';

describe('unit · scaffoldFindings', () => {
  test('a red step nobody allowed fails the job, and names the step', () => {
    const steps = [step('typecheck', false), step('lint', false), step('unit', true)];
    const findings = scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck'] });
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.cause).toContain('lint');
    expect(findings[0]?.cause).not.toContain('typecheck');
    expect(findings[0]?.fix).toBe(`cd ${DIR} && bun run verify --json`);
  });

  test('the allowed step failing on its own is the passing case', () => {
    const steps = [step('typecheck', false), step('lint', true), step('e2e', true, true)];
    expect(scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck'] })).toEqual([]);
  });

  /**
   * The other direction. The waiver exists for one pinned TS18048 gap in `x new --example`'s
   * `entity.ts`; the day that closes, a waiver nothing forces down is a waiver that keeps excusing
   * whatever lands behind it — which is exactly how it came to cover all 17 steps.
   */
  test('an allowed step that has started passing is a waiver to delete', () => {
    const steps = [step('typecheck', true), step('lint', true)];
    const findings = scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck'] });
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_GATE_RED']);
    expect(findings[0]?.fix).toBe(
      `drop --allow-red typecheck from the scaffold-smoke verify step in ${WAIVER_FILE}`,
    );
    expect(findings[0]?.at).toBe(WAIVER_FILE);
  });

  test('a green gate with no waiver at all raises nothing', () => {
    expect(scaffoldFindings({ dir: DIR, steps: [step('lint', true)], allowRed: [] })).toEqual([]);
  });

  test('no step table is the worst outcome, never a silent pass', () => {
    for (const steps of [undefined, []]) {
      const findings = scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_SCAFFOLD_GATE_RED');
      expect(findings[0]?.fix).toBe(reproduce(DIR));
    }
  });

  test('a skipped step is not red, so it neither fails the job nor satisfies a waiver', () => {
    const steps = [step('typecheck', false), step('e2e', true, true)];
    expect(scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck'] })).toEqual([]);
    const findings = scaffoldFindings({ dir: DIR, steps, allowRed: ['typecheck', 'e2e'] });
    expect(findings[0]?.cause).toContain('e2e');
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
