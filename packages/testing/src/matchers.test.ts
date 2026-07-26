import { describe, expect, test } from 'bun:test';
import './matchers';
import { recordSteps } from './matchers';

const policy = (allow: boolean) => ({ evaluate: async () => allow });

const job = {
  kind: 'job',
  run: async ({ step }: { step: { run<T>(name: string, body: () => T): Promise<T> } }) => {
    await step.run('provision', () => 1);
    await step.run('welcome-email', () => 2);
    return 'done';
  },
};

describe('unit · matchers', () => {
  test('toBeUltimateError matches on the stable code', () => {
    const error = { code: 'X_DB_DRIFT', cause: 'schema differs', fix: 'x db gen "add col"' };
    expect(error).toBeUltimateError('X_DB_DRIFT');
    expect(error).toBeUltimateError();
    expect(error).not.toBeUltimateError('X_BUDGET_EXCEEDED');
  });

  test('toBeUltimateError rejects a bare Error, because bare errors are banned', () => {
    expect(new Error('boom')).not.toBeUltimateError('X_DB_DRIFT');
    expect('X_DB_DRIFT').not.toBeUltimateError();
  });

  test('toDenyPolicy passes on a denial and fails on an allow', async () => {
    await expect(policy(false)).toDenyPolicy({ actor: null });
    await expect(policy(true)).not.toDenyPolicy({ actor: { id: 'a' } });
  });

  test('toEmitSteps pins the step sequence', async () => {
    await expect(job).toEmitSteps(['provision', 'welcome-email']);
    expect(await recordSteps(job)).toEqual(['provision', 'welcome-email']);
  });

  test('toMatchOpenApi fails when an operation disappears', () => {
    const committed = {
      operations: [{ operationId: 'publishPost' }, { operationId: 'listPosts' }],
    };
    expect({
      operations: [{ operationId: 'publishPost' }, { operationId: 'listPosts' }],
    }).toMatchOpenApi(committed);
    expect({ operations: [{ operationId: 'publishPost' }] }).not.toMatchOpenApi(committed);
  });

  test('toBeWithinBudget compares against the declared limit', () => {
    expect(40_000).toBeWithinBudget(40_960);
    expect(61_000).not.toBeWithinBudget(40_960);
  });

  test('toRejectInput and toAcceptInput speak Standard Schema', async () => {
    const uuid = {
      '~standard': {
        validate: (value: unknown) =>
          typeof value === 'object' && value !== null && 'id' in value && value.id === 'ok'
            ? {}
            : { issues: [{ message: 'expected a uuid' }] },
      },
    };
    await expect(uuid).toRejectInput({ id: 'not-a-uuid' });
    await expect(uuid).toAcceptInput({ id: 'ok' });
  });
});
