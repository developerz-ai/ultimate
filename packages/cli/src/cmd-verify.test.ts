import { describe, expect, test } from 'bun:test';
import { runVerify, VERIFY_STEPS, verifyCommand, verifyStepNames } from './cmd-verify';
import { exitCodeFor } from './output';
import type { VerifyContext, VerifyStep } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

const ctx: VerifyContext = {
  root: '/nowhere',
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
};

const stubs: readonly VerifyStep[] = [
  { name: 'typecheck', summary: 'tsc', run: async () => ({ ok: true, findings: [] }) },
  {
    name: 'drift',
    summary: 'schema vs migrations',
    run: async () => ({
      ok: false,
      findings: [
        {
          code: 'X_DB_DRIFT',
          cause: 'table "posts" has column "publish_at" not present in any migration',
          fix: 'x db gen "add publish_at"',
        },
      ],
    }),
  },
  {
    name: 'e2e',
    summary: 'playwright',
    applies: async () => false,
    run: async () => ({ ok: false, findings: [] }),
  },
];

describe('unit · x verify', () => {
  test('the step list covers every check in the contract', () => {
    expect(verifyStepNames()).toEqual([
      'typecheck',
      'lint',
      'boundaries',
      'filesize',
      'package-shape',
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
    ]);
    expect(VERIFY_STEPS.every((step) => step.summary.length > 0)).toBe(true);
  });

  test('the declared names and the steps that exist are one list', () => {
    expect(verifyStepNames()).toEqual([...VERIFY_STEP_NAMES]);
  });

  test('a failing step makes the whole run fail and exit non-zero', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(1);
    expect(result.steps?.map((step) => step.ok)).toEqual([true, false, true]);
  });

  test('every step reports its own duration and keeps its findings', async () => {
    const result = await runVerify(stubs, ctx);
    const drift = result.steps?.find((step) => step.name === 'drift');
    expect(drift?.durationMs).toBeGreaterThanOrEqual(0);
    expect(drift?.findings[0]?.fix).toBe('x db gen "add publish_at"');
  });

  test('a step that does not apply is skipped, not passed silently', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.steps?.find((step) => step.name === 'e2e')?.skipped).toBe(true);
  });

  test('it never bails early: later steps still run after a failure', async () => {
    const seen: string[] = [];
    const traced = stubs.map<VerifyStep>((step) => ({
      ...step,
      run: async (context) => {
        seen.push(step.name);
        return step.run(context);
      },
    }));
    await runVerify(traced, ctx);
    expect(seen).toEqual(['typecheck', 'drift']);
  });

  test('there is no way to narrow the run: every step runs, every time', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.steps?.map((step) => step.name)).toEqual(['typecheck', 'drift', 'e2e']);
    expect(verifyCommand.spec.flags).toEqual([]);
    expect(verifyCommand.spec.usage).toBe('x verify [--json]');
  });

  test('a host check adds findings to the step it was registered for', async () => {
    const withHost: readonly VerifyStep[] = [
      {
        name: 'boundaries',
        summary: 'imports',
        run: async (context) => {
          const extra = (await context.hostChecks?.boundaries?.(context.root)) ?? [];
          return { ok: extra.length === 0, findings: extra };
        },
      },
    ];
    const result = await runVerify(withHost, {
      ...ctx,
      hostChecks: {
        boundaries: async () => [
          { code: 'X_BOUNDARY_VIOLATION', cause: 'cli imports admin', fix: 'invert the import' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps?.[0]?.findings[0]?.code).toBe('X_BOUNDARY_VIOLATION');
  });

  test('a step that throws becomes a finding, not a crash', async () => {
    const boom: VerifyStep[] = [
      {
        name: 'boundaries',
        summary: 'imports',
        run: async () => {
          throw new Error('transpiler exploded');
        },
      },
    ];
    const result = await runVerify(boom, ctx);
    expect(result.ok).toBe(false);
    expect(result.steps?.[0]?.findings[0]?.code).toBe('X_VERIFY_FAILED');
    expect(result.steps?.[0]?.findings[0]?.fix).toBe('x verify --json');
  });
});
