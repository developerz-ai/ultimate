// The ratchet has to fail in both directions, or it is not a ratchet: a step that stops passing
// and a pinned step that starts passing are both findings. These pin that, plus the build-graph
// rule that fires the moment the app compiles.

import { describe, expect, test } from 'bun:test';
import type { ExecResult } from '@ultimat3/cli';
import { repoRoot } from './lib/run';
import type { GateStep } from './reference-app-gate';
import {
  EXPECTED_RED,
  gateFindings,
  parseSteps,
  REFERENCE_ENTRY,
  redSteps,
  referencesApp,
  runReferenceAppGate,
  stepLines,
} from './reference-app-gate';

const step = (name: string, ok: boolean, skipped = false): GateStep => ({
  name,
  ok,
  skipped,
  findings: [],
});

const pin = { typecheck: 'owned elsewhere', drift: 'owned elsewhere' } as const;

describe('gateFindings', () => {
  test('passes when the red steps are exactly the pinned ones', () => {
    const steps = [step('typecheck', false), step('drift', false), step('lint', true)];
    expect(gateFindings({ steps, expectedRed: pin, referenced: false })).toEqual([]);
  });

  test('a step that was passing and now fails is a regression', () => {
    const steps = [step('typecheck', false), step('drift', false), step('lint', false)];
    const findings = gateFindings({ steps, expectedRed: pin, referenced: false });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(findings[0]?.cause).toContain('lint');
    expect(findings[0]?.fix).toContain('examples/dummy');
  });

  test('a pinned step that starts passing is a stale pin, so the pin can only shrink', () => {
    const steps = [step('typecheck', false), step('drift', true), step('lint', true)];
    const findings = gateFindings({ steps, expectedRed: pin, referenced: false });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
    expect(findings[0]?.fix).toContain('EXPECTED_RED');
    expect(findings[0]?.fix).toContain('drift');
  });

  test('a skipped step counts as not-red, not as a regression', () => {
    const steps = [step('typecheck', false), step('drift', false), step('roadmap', true, true)];
    expect(gateFindings({ steps, expectedRed: pin, referenced: false })).toEqual([]);
  });

  test('no step table at all is the worst outcome, never a silent pass', () => {
    const findings = gateFindings({ steps: undefined, expectedRed: pin, referenced: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(gateFindings({ steps: [], expectedRed: pin, referenced: true })).toHaveLength(1);
  });

  test('an app that typechecks must be in the root build graph', () => {
    const steps = [step('typecheck', true), step('drift', false)];
    const codes = gateFindings({ steps, expectedRed: pin, referenced: false }).map((f) => f.code);
    expect(codes).toContain('X_REFERENCE_APP_UNREFERENCED');
    // Both are true at once and each needs its own edit: lower the pin AND add the reference.
    expect(codes).toContain('X_REFERENCE_APP_PIN_STALE');
  });

  test('once referenced, a green typecheck raises nothing', () => {
    const steps = [step('typecheck', true), step('drift', false)];
    const codes = gateFindings({
      steps,
      expectedRed: { drift: 'owned elsewhere' },
      referenced: true,
    }).map((f) => f.code);
    expect(codes).toEqual([]);
  });

  test('an empty pin means the app must be 100% green', () => {
    const steps = [step('typecheck', true), step('lint', false)];
    const codes = gateFindings({ steps, expectedRed: {}, referenced: true }).map((f) => f.code);
    expect(codes).toEqual(['X_REFERENCE_APP_REGRESSED']);
  });
});

describe('parseSteps', () => {
  const payload = JSON.stringify({
    ok: false,
    steps: [
      { name: 'lint', ok: true, durationMs: 1, skipped: false, findings: [] },
      {
        name: 'drift',
        ok: false,
        durationMs: 2,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'x db gen "m"', docs: 'd' }],
      },
    ],
  });

  test('reads the step table and keeps each finding’s three lines', () => {
    const steps = parseSteps(`${payload}\n`);
    expect(steps?.map((s) => s.name)).toEqual(['lint', 'drift']);
    expect(steps?.[1]?.findings[0]).toEqual({
      code: 'X_DB_DRIFT',
      cause: 'c',
      fix: 'x db gen "m"',
    });
    expect(redSteps(steps ?? [])).toEqual(['drift']);
  });

  test('a stray line before the payload does not make the gate unreadable', () => {
    expect(parseSteps(`warming up\n${payload}\n`)?.length).toBe(2);
  });

  test('unusable output is undefined rather than an empty pass', () => {
    expect(parseSteps('')).toBeUndefined();
    expect(parseSteps('{ not json')).toBeUndefined();
    expect(parseSteps('{"ok":true}')).toBeUndefined();
    expect(parseSteps('{"steps":[{"name":"lint"}]}')).toBeUndefined();
  });
});

describe('wiring', () => {
  test('the root tsconfig is read for a real reference entry, not a substring', async () => {
    expect(await referencesApp(repoRoot())).toBe(false);
    expect(REFERENCE_ENTRY).toBe('./examples/dummy');
  });

  test('every pinned step name is one the gate can actually report', async () => {
    const { VERIFY_STEP_NAMES } = await import('@ultimat3/cli');
    const names: readonly string[] = VERIFY_STEP_NAMES;
    for (const name of Object.keys(EXPECTED_RED)) expect(names).toContain(name);
  });

  test('every pin states who owns it, so the table cannot grow anonymous entries', () => {
    for (const reason of Object.values(EXPECTED_RED)) expect(reason.length).toBeGreaterThan(20);
  });

  test('the step table renders pinned steps and their findings', () => {
    const steps: GateStep[] = [
      {
        name: 'drift',
        ok: false,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'f' }],
      },
      step('roadmap', true, true),
    ];
    const lines = stepLines(steps, pin).join('\n');
    expect(lines).toContain('✗ drift');
    expect(lines).toContain('pinned');
    expect(lines).toContain('X_DB_DRIFT');
    expect(lines).toContain('- roadmap');
  });

  test('runs the app gate in the app, through the repo’s own CLI entry point', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const fake = async (command: readonly string[], options: { cwd: string }) => {
      calls.push({ command, cwd: options.cwd });
      return {
        command,
        code: 1,
        ok: false,
        stdout: '{"steps":[{"name":"lint","ok":true,"skipped":false,"findings":[]}]}',
        stderr: '',
        durationMs: 0,
      } satisfies ExecResult;
    };
    const steps = await runReferenceAppGate('/repo', fake);
    expect(steps?.map((s) => s.name)).toEqual(['lint']);
    expect(calls[0]?.cwd).toBe('/repo/examples/dummy');
    expect(calls[0]?.command).toEqual([
      'bun',
      'run',
      '/repo/packages/cli/src/bin.ts',
      'verify',
      '--json',
    ]);
  });
});
