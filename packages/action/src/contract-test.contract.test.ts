/**
 * The generated assertions, driven against actions built to fail each one — because a
 * generated test that cannot fail is worse than none. Assertion 2 accepted ANY UltimateError
 * and sent `{}`, which fails `input:` for every action with a required field: it passed on
 * `X_INPUT_INVALID` for the whole reference app and never once reached a policy.
 */

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ContractTest, ContractTestOptions } from './contract-test';
import { contractTestsFor } from './contract-test';
import { ContractDriftError } from './errors';
import type { ActionPolicy } from './policy-gate';

const Input = t.object({ postId: t.uuid, notify: t.boolean.default(true) });
const Output = t.object({ id: t.uuid, published: t.boolean });

const publish = (policy: ActionPolicy, options?: ContractTestOptions): readonly ContractTest[] =>
  contractTestsFor(
    action({
      input: Input,
      output: Output,
      policy,
      handle: ({ input }) => ({ id: input.postId, published: input.notify }),
    }).named('publishPost'),
    options,
  );

const denial = (contracts: readonly ContractTest[]): ContractTest => at(contracts, 1);
const garbage = (contracts: readonly ContractTest[]): ContractTest => at(contracts, 0);

/**
 * The pinned position of each generated assertion. Reaching past the end means the projection
 * emits a different set than the one this file drives — drift in the generator itself, which is
 * a coded failure like any other, not a bare throw with no fix line.
 */
function at(contracts: readonly ContractTest[], index: number): ContractTest {
  const contract = contracts[index];
  if (contract === undefined) {
    throw new ContractDriftError(
      `contractTestsFor emitted ${contracts.length} assertions, so index ${index} is past the end`,
      'bun test packages/action/src/contract-test.contract.test.ts  # then repin the indices',
    );
  }
  return contract;
}

/** The `fix:` is the half an agent runs, so it is asserted as a field, not through `toString`. */
function fixOf(error: unknown): string {
  return isUltimateError(error) ? error.fix : `not an UltimateError: ${String(error)}`;
}

function causeOf(error: unknown): string {
  return isUltimateError(error) ? error.cause : `not an UltimateError: ${String(error)}`;
}

describe('the policy assertion', () => {
  test('holds for can(): a null actor is X_UNAUTHENTICATED, and that IS the policy deciding', async () => {
    // The reason this asserts the denial and not the literal `X_FORBIDDEN`: `can()` is the
    // blessed constructor and it answers a null actor with the authentication code, so a
    // one-code assertion would fail every action authored the way the framework teaches.
    await denial(publish(can('post:publish'))).run();
  });

  test('holds for the tenancy predicate `x g action` scaffolds, which never runs for nobody', async () => {
    // The generated shape, verbatim: `can(perm, ({ actor, input }) => …)`. The grant check
    // short-circuits on a null actor, so the predicate is unreachable here — asserted by
    // making it throw if it is ever reached.
    const guarded = can('post:publish', () => {
      throw new Error('the tenancy predicate ran for an actor of null');
    });
    await denial(publish(guarded)).run();
  });

  test('fails when the policy lets an anonymous actor through', async () => {
    // The regression. `allow()` runs the handler for a signed-out caller; with the old `{}`
    // input the schema rejected it first and the assertion reported success.
    const failure = await denial(publish(allow()))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_CONTRACT_DRIFT');
    expect(causeOf(failure)).toBe('publishPost ran for an actor of null');
  });

  test('reaches the policy through the row loader, with the synthesized input', async () => {
    const seen: unknown[] = [];
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      row: ({ input }) => {
        seen.push(input);
        return null;
      },
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishWithRow');

    await denial(contractTestsFor(target)).run();
    expect(seen).toEqual([{ postId: '00000000-0000-4000-8000-000000000000', notify: true }]);
  });

  test('reports drift, naming `input:`, when the sample cannot satisfy the schema', async () => {
    const target = action({
      input: t.object({ code: t.string.pattern(/^\d+$/) }),
      output: Output,
      policy: can('post:publish'),
      handle: () => ({ id: '00000000-0000-4000-8000-000000000000', published: true }),
    }).named('publishByCode');

    const failure = await denial(contractTestsFor(target))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_CONTRACT_DRIFT');
    // Not silence, and not a pass: an assertion that could not run says so and says how to fix it.
    expect(causeOf(failure)).toContain('X_INPUT_INVALID before its policy decided');
    expect(fixOf(failure)).toContain('pass `input:` to contractTestsFor(publishByCode)');
  });

  test('an explicit `input:` overrides the synthesized one', async () => {
    const target = action({
      input: t.object({ code: t.string.pattern(/^\d+$/) }),
      output: Output,
      policy: can('post:publish'),
      handle: () => ({ id: '00000000-0000-4000-8000-000000000000', published: true }),
    }).named('publishByCode');

    await denial(contractTestsFor(target, { input: { code: '42' } })).run();
  });

  test("a handler's own failure keeps its own stack rather than becoming drift", async () => {
    const target = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: () => {
        throw new TypeError('undefined is not an object');
      },
    }).named('publishBroken');

    const failure = await denial(contractTestsFor(target))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
  });

  test('a coded failure the policy could not have caused keeps its code, not `input:` drift', async () => {
    // The branch used to read every UltimateError as "before its policy decided". This one is
    // raised after `allow()` let a null actor through, so the old message named a stage it had
    // not checked and offered `input:`, a knob that changes nothing about an output schema.
    const target = action({
      input: Input,
      output: t.object({ id: t.uuid, published: t.boolean }),
      policy: allow(),
      handle: () => ({ id: 'not-a-uuid', published: true }),
    }).named('publishMalformed');

    const failure = await denial(contractTestsFor(target))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_OUTPUT_INVALID');
    expect(fixOf(failure)).not.toContain('pass `input:`');
  });
});

describe('the garbage assertion', () => {
  test('holds: null is not a valid input for any object schema', async () => {
    await garbage(publish(can('post:publish'))).run();
  });

  test('pins X_INPUT_INVALID rather than any failure — a denial is not a rejected input', async () => {
    const contracts = publish(can('post:publish'), {
      garbage: { postId: '00000000-0000-4000-8000-000000000000' },
    });
    const failure = await garbage(contracts)
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_CONTRACT_DRIFT');
    expect(causeOf(failure)).toContain('got X_UNAUTHENTICATED, expected X_INPUT_INVALID');
  });
});
