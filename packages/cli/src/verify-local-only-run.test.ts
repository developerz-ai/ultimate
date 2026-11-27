// `localOnly` through the runner: CI leaves the named step out, a laptop and `--only` run it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no API for creating or removing a temporary directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep, VerifyStepName } from './verify-step';

const root = mkdtempSync(join(tmpdir(), 'local-only-'));
writeFileSync(
  join(root, 'x.verify.json'),
  JSON.stringify({ steps: [], localOnly: { e2e: 'a real browser: run locally' } }),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function verified(
  env: Record<string, string>,
  only?: VerifyStepName[],
): Promise<{ ran: string[]; result: Awaited<ReturnType<typeof runVerify>> }> {
  const ran: string[] = [];
  const step = (name: VerifyStep['name']): VerifyStep => ({
    name,
    summary: name,
    run: async () => {
      ran.push(name);
      return { ok: true, findings: [] };
    },
  });
  const ctx: VerifyContext = {
    root,
    env,
    ...(only === undefined ? {} : { only }),
    runner: async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  };
  const result = await runVerify([step('lint'), step('e2e')], ctx);
  return { ran: ran.sort(), result };
}

const stepsRun = async (env: Record<string, string>, only?: VerifyStepName[]) =>
  (await verified(env, only)).ran;

describe('unit · x.verify.json localOnly', () => {
  test('CI runs every step but the local-only one', async () => {
    expect(await stepsRun({ CI: 'true' })).toEqual(['lint']);
  });

  test('a CI run says what it left out and why, in data and in a line', async () => {
    const { result } = await verified({ CI: 'true' });
    expect(result.data).toMatchObject({ localOnly: { e2e: 'a real browser: run locally' } });
    expect(result.lines).toContain('left out in CI: e2e — a real browser: run locally');
    const local = await verified({});
    expect(local.result.data).not.toHaveProperty('localOnly');
  });

  test('a developer machine runs all of them', async () => {
    expect(await stepsRun({})).toEqual(['e2e', 'lint']);
  });

  test('--only names the step: it runs even in CI', async () => {
    expect(await stepsRun({ CI: 'true' }, ['e2e'])).toEqual(['e2e']);
  });
});
