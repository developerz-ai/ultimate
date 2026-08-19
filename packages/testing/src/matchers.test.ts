import { describe, expect, test } from 'bun:test';
import './matchers';
import { recordSteps } from './matchers';

const policy = (allow: boolean) => ({ evaluate: async () => allow });

/** The shape @ultimat3/policy actually builds: one `run()`, and `row` is a required field. */
const runnable = (allow: boolean) => ({
  seen: [] as unknown[],
  run(args: Readonly<Record<string, unknown>>) {
    this.seen.push(args['row']);
    return { allowed: allow };
  },
});

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

  test('toBeUltimateError rejects a Node errno — a string `code` is not the contract', () => {
    // The regression this matcher exists to catch, walking straight through it: `ENOENT` is a
    // string `code`, so "any object with a string code" passed a suite whose whole job is
    // pinning "never throw a bare Error". A code is `X_*` and carries a cause and a fix.
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(enoent).not.toBeUltimateError();
    expect(enoent).not.toBeUltimateError('ENOENT');
    expect({ code: 'ECONNRESET' }).not.toBeUltimateError();
    // An `X_` code with no cause and no fix is not the contract either — the three travel together.
    expect({ code: 'X_MADE_UP' }).not.toBeUltimateError();
    expect({ code: 'X_MADE_UP', cause: 'c' }).not.toBeUltimateError();
  });

  test('toBeUltimateError reads through a hostile getter instead of raising inside the matcher', () => {
    // A matcher that throws on `received.code` fails the whole file with the wrong error, and
    // `.not.toBeUltimateError()` on such a value is exactly what a hardening test asserts.
    const hostile = {
      get code(): string {
        throw new TypeError('nope');
      },
    };
    expect(hostile).not.toBeUltimateError();
  });

  test('toDenyPolicy passes on a denial and fails on an allow', async () => {
    await expect(policy(false)).toDenyPolicy({ actor: null });
    await expect(policy(true)).not.toDenyPolicy({ actor: { id: 'a' } });
  });

  // A real `Policy` has no `evaluate()`, so the matcher used to answer "not a policy" for every
  // policy the framework builds — which reads as a denial and never fails on an allow.
  test('toDenyPolicy decides a real Policy through its run()', async () => {
    await expect(runnable(false)).toDenyPolicy({ actor: null, input: {} });
    await expect(runnable(true)).not.toDenyPolicy({ actor: { id: 'a' }, input: {} });
  });

  test('toDenyPolicy defaults row to null, and a caller-supplied row wins', async () => {
    const denies = runnable(false);
    await expect(denies).toDenyPolicy({ actor: null, input: {} });
    await expect(denies).toDenyPolicy({ actor: null, input: {}, row: { id: 'r' } });
    expect(denies.seen).toEqual([null, { id: 'r' }]);
  });

  // `.not.toDenyPolicy` passes here for the wrong reason: `.not` is satisfied by any `pass: false`,
  // and "the policy allowed" returns exactly that — so it holds even with the type guards deleted.
  // Assert the message instead. Bun settles an async matcher inside `expect()` and throws the
  // failure synchronously, so `expect(fn).toThrow()` sees it; `.rejects` wants a promise, and the
  // call has already thrown by the time it gets one.
  test('toDenyPolicy fails loudly on something that is not a policy at all', () => {
    expect(() => expect({ nope: true }).toDenyPolicy({ actor: null })).toThrow(
      'expected a policy — an object with run() (@ultimat3/policy) or evaluate()',
    );
    // ...and that diagnostic is a different one from a policy that simply allowed.
    expect(() => expect(policy(true)).toDenyPolicy({ actor: null })).toThrow(
      'expected the policy to deny {"actor":null}',
    );
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

  // A parameter that was optional and is now required breaks every caller that already omits it,
  // and the matcher compared operation ids alone — so a suite naming it read as covered while the
  // one change most likely to break a client passed.
  test('toMatchOpenApi fails when a surviving operation newly requires a parameter', () => {
    const committed = { operations: [{ operationId: 'listPosts', required: ['orgId'] }] };
    expect({ operations: [{ operationId: 'listPosts', required: ['orgId'] }] }).toMatchOpenApi(
      committed,
    );
    expect({
      operations: [{ operationId: 'listPosts', required: ['orgId', 'cursor'] }],
    }).not.toMatchOpenApi(committed);
    // Dropping a requirement widens what the API accepts, so it is not breaking.
    expect({ operations: [{ operationId: 'listPosts', required: [] }] }).toMatchOpenApi(committed);
  });

  // The received value is `unknown`: a matcher that casts and dereferences turns "you passed the
  // wrong thing" into a TypeError with no code, from inside the assertion library.
  test('toMatchOpenApi refuses a received value that is not an OpenAPI document', () => {
    expect({ paths: {} }).not.toMatchOpenApi({ operations: [] });
    expect(null).not.toMatchOpenApi({ operations: [] });
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
