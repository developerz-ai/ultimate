// A step that THREW: a coded error's own code and fix are what the gate prints, because the
// gate's generic fix (`x verify --json`) only reruns the step that just threw.

import { expect, test } from 'bun:test';
import { BadFlagError } from './errors';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';

const ctx: VerifyContext = {
  root: '/no/such/app',
  runner: async (command) => ({
    command,
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
};

test('unit · a coded throw is reported with its own code in the cause and its own fix', async () => {
  const thrown = new BadFlagError({
    flag: 'port',
    command: 'dev',
    reason: 'is not a number',
    fix: 'x dev --port 3000',
  });
  const step: VerifyStep = {
    name: 'manifest',
    summary: 'manifest',
    run: async () => {
      throw thrown;
    },
  };
  const result = await runVerify([step], ctx);
  const [finding] = result.steps?.[0]?.findings ?? [];
  expect(finding?.code).toBe('X_VERIFY_FAILED');
  expect(finding?.cause).toStartWith(`step "manifest" threw ${thrown.code}: `);
  expect(finding?.fix).toBe(thrown.fix);
});
