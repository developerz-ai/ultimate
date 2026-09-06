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

// The three matchers that quote the value they were given used `JSON.stringify` to do it, and
// built the string EAGERLY — before the verdict was known. So a schema that correctly rejected a
// `1n` never got to say so: `JSON.stringify` raises on a BigInt, and the matcher replaced the
// test's real answer with a TypeError from inside the assertion library. Same for anything cyclic,
// and same on the PASSING path, where the message is never read at all.
describe('unit · matchers render the value they were handed, and never raise doing it', () => {
  const rejecting = {
    '~standard': { validate: () => ({ issues: [{ message: 'no' }] }) },
  };
  const accepting = { '~standard': { validate: () => ({}) } };

  const cyclic = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    self['self'] = self;
    return self;
  };

  test('toRejectInput passes on a bigint the schema rejects', async () => {
    await expect(rejecting).toRejectInput({ n: 1n });
    await expect(rejecting).toRejectInput(1n);
  });

  test('toRejectInput passes on a cyclic input the schema rejects', async () => {
    await expect(rejecting).toRejectInput(cyclic());
  });

  test('toAcceptInput passes on a bigint the schema accepts', async () => {
    await expect(accepting).toAcceptInput({ n: 1n });
    await expect(accepting).toAcceptInput(cyclic());
  });

  test('toDenyPolicy passes on a context holding a bigint', async () => {
    await expect(policy(false)).toDenyPolicy({ actor: null, seats: 1n });
    await expect(policy(false)).toDenyPolicy(cyclic());
  });

  // And the failing side still NAMES the value — a message that degraded to "an object" for every
  // input would make the two halves of `expected the schema to reject X` unreadable.
  test('the failure message still quotes an ordinary input', async () => {
    let caught: unknown;
    try {
      await expect(accepting).toRejectInput({ id: 'ok' });
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) expect.unreachable('an accepting schema passed toRejectInput');
    expect(String((caught as { message?: unknown }).message)).toContain('{"id":"ok"}');
  });

  // A value JSON cannot serialize still fails as a FAILURE, with a message, not as a TypeError
  // from inside the matcher.
  test('a bigint on the failing side is a failed assertion, never a TypeError', async () => {
    let caught: unknown;
    try {
      await expect(accepting).toRejectInput({ n: 1n });
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) expect.unreachable('an accepting schema passed toRejectInput');
    expect(String((caught as { message?: unknown }).message)).toContain(
      'expected the schema to reject',
    );
  });
});

// A matcher's message is read on exactly ONE path — the wrong verdict — so a message no test
// provokes is a sentence nobody has ever seen. `.not` on a `pass: false` is satisfied without
// reading it, which is how `expect({ paths: {} }).not.toMatchOpenApi(…)` above passes with the
// type guard deleted: every assertion here provokes the failing side and reads the sentence.
describe('unit · matchers say what went wrong, on the side that fails', () => {
  /** The failing side of an async matcher, whether bun throws it or rejects with it. */
  const messageOf = async (run: () => Promise<unknown> | unknown): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return String((error as { message?: unknown }).message);
    }
    return expect.unreachable('the matcher passed where the assertion was meant to fail');
  };

  const error = { code: 'X_DB_DRIFT', cause: 'schema differs', fix: 'x db gen "add col"' };

  test('toBeUltimateError names the value it was handed instead', async () => {
    expect(await messageOf(() => expect('X_DB_DRIFT').toBeUltimateError())).toContain(
      'expected an UltimateError (an X_ code with a cause and a fix), received',
    );
  });

  test('toBeUltimateError names both codes when they differ', async () => {
    expect(await messageOf(() => expect(error).toBeUltimateError('X_BUDGET_EXCEEDED'))).toContain(
      'expected error code X_BUDGET_EXCEEDED, received X_DB_DRIFT',
    );
  });

  // The `.not` side of the code-less form is the only path that reads this one: `pass` is true,
  // so bun asks for the message precisely because the caller said the value should NOT be one.
  test('toBeUltimateError under .not says the value was one after all', async () => {
    expect(await messageOf(() => expect(error).not.toBeUltimateError())).toContain(
      'expected not to be an UltimateError',
    );
  });

  test('toEmitSteps prints the sequence it wanted beside the one it ran', async () => {
    expect(await messageOf(() => expect(job).toEmitSteps(['provision']))).toContain(
      'expected steps provision, ran provision -> welcome-email',
    );
  });

  test('toMatchOpenApi names the shape it wanted from a receiver that is not one', async () => {
    expect(
      await messageOf(() => expect({ paths: {} }).toMatchOpenApi({ operations: [] })),
    ).toContain(
      'expected an OpenAPI document — an object with operations: [{ operationId, required? }]',
    );
  });

  test('toMatchOpenApi lists what broke, and what to do about it', async () => {
    const committed = {
      operations: [{ operationId: 'publishPost' }, { operationId: 'listPosts', required: [] }],
    };
    expect(
      await messageOf(() =>
        expect({ operations: [{ operationId: 'listPosts', required: ['cursor'] }] }).toMatchOpenApi(
          committed,
        ),
      ),
    ).toContain(
      'contract broke: removed operation publishPost; listPosts newly requires cursor — bump the package version or restore the old shape',
    );
  });

  test('toBeWithinBudget names the type it got where a number belongs', async () => {
    expect(await messageOf(() => expect('40kb').toBeWithinBudget(40_960))).toContain(
      'expected a number to compare against the budget, got string',
    );
  });

  test('toBeWithinBudget prints the measurement beside the limit', async () => {
    expect(await messageOf(() => expect(61_000).toBeWithinBudget(40_960))).toContain(
      'expected 61000 to be within the budget of 40960',
    );
  });

  test('toAcceptInput quotes the input the schema rejected', async () => {
    const rejecting = { '~standard': { validate: () => ({ issues: [{ message: 'no' }] }) } };
    expect(await messageOf(() => expect(rejecting).toAcceptInput({ id: 'ok' }))).toContain(
      'expected the schema to accept {"id":"ok"}',
    );
  });
});

// `recordSteps` hands the job a `sleep` that returns immediately: a job that waits an hour between
// steps is still a step SEQUENCE, and the assertion is on the sequence rather than on the delay.
// Without it the matcher would either hang for the real duration or need the job rewritten to be
// testable.
test('unit · recordSteps runs a sleeping job at once, and does not count the sleep as a step', async () => {
  const sleeper = {
    kind: 'job',
    run: async ({
      step,
    }: {
      step: { run<T>(name: string, body: () => T): Promise<T>; sleep(d: string): Promise<void> };
    }) => {
      await step.run('charge', () => 1);
      await step.sleep('1h');
      await step.run('receipt', () => 2);
    },
  };
  await expect(sleeper).toEmitSteps(['charge', 'receipt']);
});
