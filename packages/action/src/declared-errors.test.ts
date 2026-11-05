// `errors:` on an action, the dynamic half: judged around `handle` and `row` only. An undeclared
// 4xx is red in a test run and the original in production; a policy denial, `X_INPUT_INVALID` and
// a declared code are never judged.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  collectMetrics,
  ctxOf,
  defineError,
  isUltimateError,
  resetMetrics,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { ActionDeniedError } from './errors';
import { handlerReached } from './invoke';
import { registerAction, resetActions } from './registry';

const Late = defineError({
  code: 'X_DECLARED_REFUND_LATE',
  title: 'action declared-errors fixture: too late',
  status: 409,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});
const Small = defineError({
  code: 'X_DECLARED_REFUND_SMALL',
  title: 'action declared-errors fixture: too small',
  status: 422,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

const Input = t.object({ amount: t.number });
const Output = t.object({ ok: t.boolean });

const refund = (
  throwFrom: 'handle' | 'row',
  errors: readonly string[] = ['X_DECLARED_REFUND_LATE'],
) =>
  registerAction(
    'refundOrder',
    action({
      input: Input,
      output: Output,
      policy: can('order:refund'),
      errors,
      row: ({ input }) => {
        if (throwFrom === 'row' && input.amount < 0) throw new Small();
        return null;
      },
      handle: ({ input }) => {
        if (input.amount > 100) throw new Late();
        if (input.amount < 1) throw new Small();
        return { ok: true };
      },
    }),
  );

const actorCtx = (permissions: readonly string[]) =>
  ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions } });
const ctx = actorCtx(['order:refund']);

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call answered');
}

afterEach(() => {
  resetActions();
  resetMetrics();
});

describe('an action declaring errors:', () => {
  test('a declared refusal passes through as itself', async () => {
    const target = refund('handle');
    const error = await rejection(() => target({ amount: 500 }, { ctx }));
    expect(Late.is(error)).toBe(true);
  });

  test('an undeclared 4xx out of handle is X_ERROR_UNDECLARED in a test run', async () => {
    const target = refund('handle');
    const error = await rejection(() => target({ amount: 0 }, { ctx }));
    if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
    expect(error.code).toBe('X_ERROR_UNDECLARED');
    expect(error.fix).toContain(
      "'X_DECLARED_REFUND_SMALL' ]   # add it in the refundOrder definition",
    );
    expect(Small.is(error.sourceError)).toBe(true);
    expect(handlerReached(target)).toBe(1);
  });

  test('an undeclared 4xx out of row is judged the same', async () => {
    const target = refund('row');
    const error = await rejection(() => target({ amount: -1 }, { ctx }));
    expect(isUltimateError(error) && error.code).toBe('X_ERROR_UNDECLARED');
    expect(handlerReached(target)).toBe(0);
  });

  test('production answers the original and counts it', async () => {
    const target = refund('handle');
    const saved = process.env['ULTIMATE_ENV'];
    process.env['ULTIMATE_ENV'] = 'production';
    try {
      const error = await rejection(() => target({ amount: 0 }, { ctx }));
      expect(Small.is(error)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = saved;
    }
    const metric = collectMetrics().metrics.find(
      (entry) => entry.descriptor.name === 'undeclared_errors_total',
    );
    expect(metric?.points[0]?.attributes).toEqual({
      primitive: 'action',
      name: 'refundOrder',
      code: 'X_DECLARED_REFUND_SMALL',
    });
  });

  test('a policy denial and X_INPUT_INVALID are never judged, even under errors: []', async () => {
    const target = refund('handle', []);
    const denied = await rejection(() => target({ amount: 5 }, { ctx: actorCtx([]) }));
    expect(denied).toBeInstanceOf(ActionDeniedError);
    const invalid = await rejection(() => target({ amount: 'many' } as never, { ctx }));
    expect(isUltimateError(invalid) && invalid.code).toBe('X_INPUT_INVALID');
  });

  test('the list is checked, frozen and sorted where it is written, and described', () => {
    const target = refund('handle', ['X_DECLARED_REFUND_SMALL', 'X_DECLARED_REFUND_LATE']);
    expect(target.errors).toEqual(['X_DECLARED_REFUND_LATE', 'X_DECLARED_REFUND_SMALL']);
    expect(target.describe().errors).toEqual(target.errors ?? null);
    expect(() => refund('handle', ['X_NEVER_DECLARED_ANYWHERE'])).toThrow(
      expect.objectContaining({ code: 'X_ACTION_ERRORS_INVALID' }),
    );
  });
});
