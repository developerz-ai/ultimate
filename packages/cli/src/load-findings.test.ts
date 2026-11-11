// One broken module, one red line: the app's load failures are the `manifest` step's, and every
// other step that loads the app stands down and says where they went instead of reporting what a
// half-loaded registry looks like (a typo read as 9 findings across 7 steps, plan 101 19a FX8).

import { describe, expect, test } from 'bun:test';
import { blockedByLoad, LOAD_BLOCKED, LOAD_OWNER, withLoadFindings } from './load-findings';
import type { Finding } from './output';
import type { VerifyContext, VerifyStep } from './verify-step';

const broken: Finding = {
  code: 'X_APP_MODULE_FAILED',
  cause: 'apps/web/app/post/entity.ts: SyntaxError',
  fix: 'x verify --only typecheck --json',
  at: 'apps/web/app/post/entity.ts',
};
const own: Finding = { code: 'X_BUDGET_UNMEASURED', cause: '/posts has no stats', fix: 'x build' };
const failing = async () => ({ findings: [broken] });
const clean = async () => ({ findings: [] });

/** A step that counts its runs and reports a symptom of the half-loaded registry. */
const symptomatic = () => {
  const calls = { run: 0 };
  const step: VerifyStep = {
    name: 'budgets',
    summary: 'weighs',
    applies: async () => true,
    run: async () => {
      calls.run += 1;
      return { ok: false, findings: [own] };
    },
  };
  return { step, calls };
};

const ctx = (only?: VerifyContext['only']): VerifyContext =>
  ({ root: '/app', runner: async () => expect.unreachable('no child'), only }) as VerifyContext;

describe('unit · a load failure is reported once', () => {
  test('a gate run: the dependent step does not run, finds nothing, and points at the owner', async () => {
    const { step, calls } = symptomatic();
    const outcome = await blockedByLoad(step, failing).run(ctx());
    expect(calls.run).toBe(0);
    expect(outcome).toEqual({ ok: true, findings: [], output: LOAD_BLOCKED });
    expect(LOAD_BLOCKED).toBe(`skipped: load failed (see ${LOAD_OWNER})`);
  });

  test('a run that includes the owner counts as a gate run', async () => {
    const { step } = symptomatic();
    const outcome = await blockedByLoad(step, failing).run(ctx(['budgets', LOAD_OWNER]));
    expect(outcome.findings).toEqual([]);
  });

  test('a narrowed run without the owner carries the root cause itself — never a vacuous green', async () => {
    const { step, calls } = symptomatic();
    const outcome = await blockedByLoad(step, failing).run(ctx(['budgets']));
    expect(calls.run).toBe(0);
    expect(outcome).toEqual({ ok: false, findings: [broken], output: LOAD_BLOCKED });
  });

  test('a clean load runs the step untouched, keeping its name, summary and applies', async () => {
    const { step, calls } = symptomatic();
    const wrapped = blockedByLoad(step, clean);
    expect(await wrapped.run(ctx())).toEqual({ ok: false, findings: [own] });
    expect(calls.run).toBe(1);
    expect([wrapped.name, wrapped.summary, wrapped.applies]).toEqual([
      step.name,
      step.summary,
      step.applies,
    ]);
  });

  test('the owner carries it exactly once, even when its own check repeated it', async () => {
    expect(await withLoadFindings('/app', [broken, own], failing)).toEqual([broken, own]);
    expect(await withLoadFindings('/app', [], failing)).toEqual([broken]);
  });
});
