// A stubbed action answers from its script on the REAL path: its policy still refuses, its input is
// still parsed (the stub records the parsed value), its output schema still checks the canned
// answer, and the next test runs the declared handler again.

import { describe, expect } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { InternalError, userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { stub } from './stub';
import { unitTest } from './test-types';

const handled: string[] = [];
// `.as()` and not a bare call: a test body has no request context to inherit an actor from.
const ada = userActor({ id: 'ada', orgId: 'org-1' });

const charge = action({
  input: t.object({ cartId: t.string, cents: t.number.int() }),
  output: t.object({ chargeId: t.string }),
  policy: allow(),
  async handle({ input }) {
    handled.push(input.cartId);
    return { chargeId: `real-${input.cartId}` };
  },
});
const guarded = action({
  input: t.object({ id: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: deny('stubbed primitives still answer to their policy'),
  async handle() {
    return { ok: true };
  },
});
// Named in place, as the boot names an app's exports: a stub keys on the object the test imported.
registerActions({ stubActionCharge: charge, stubActionGuarded: guarded });

describe('stub(action)', () => {
  unitTest('the handler is the script; the call is recorded with its actor', async () => {
    const stubbed = await stub(charge);
    stubbed.returns({ chargeId: 'ch_1' }, { chargeId: 'ch_2' });
    expect(await charge.as(ada, { cartId: 'c1', cents: 500 })).toEqual({ chargeId: 'ch_1' });
    expect(await charge.as(ada, { cartId: 'c2', cents: 100 })).toEqual({ chargeId: 'ch_2' });
    expect(await charge.as(ada, { cartId: 'c3', cents: 100 })).toEqual({ chargeId: 'ch_2' });
    expect(handled).toEqual([]);
    expect(stubbed.calls[0]?.actor.id).toBe('ada');
    expect(stubbed).toHaveBeenCalledWith({ cartId: 'c2', cents: 100 });
  });

  unitTest('the next test runs the declared handler again', async () => {
    expect(await charge.as(ada, { cartId: 'c9', cents: 1 })).toEqual({ chargeId: 'real-c9' });
    expect(handled).toEqual(['c9']);
  });

  unitTest('the output schema still judges the canned answer', async () => {
    const stubbed = await stub(charge);
    stubbed.returns({ chargeId: 42 } as never);
    await expect(charge.as(ada, { cartId: 'c1', cents: 1 })).rejects.toBeUltimateError();
  });

  unitTest('a scripted throw is the call failing with that error', async () => {
    const stubbed = await stub(charge);
    stubbed.throws(new InternalError({ cause: 'card declined', fix: 'none' }));
    await expect(charge.as(ada, { cartId: 'c1', cents: 1 })).rejects.toBeUltimateError(
      'X_INTERNAL',
    );
  });

  unitTest('the policy still refuses before the stub is reached', async () => {
    const stubbed = await stub(guarded);
    stubbed.returns({ ok: true });
    const nobody = userActor({ id: 'eve', orgId: 'org-1' });
    await expect(guarded.as(nobody, { id: 'x' })).rejects.toBeUltimateError();
    expect(stubbed.calls).toHaveLength(0);
  });

  unitTest('an input the parse refuses never reaches the stub', async () => {
    const stubbed = await stub(charge);
    stubbed.returns({ chargeId: 'ch_1' });
    await expect(charge.as(ada, { cartId: 'c1', cents: 1.5 })).rejects.toBeUltimateError();
    expect(stubbed.calls).toHaveLength(0);
  });
});
