// Failure capture at `invoke`: a 5xx keeps its input masked by the action's own schema, a refusal
// under 500 keeps nothing, and an action with capture off is untouched.

import { afterEach, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import {
  ctxOf,
  REDACTED,
  reportError,
  settleFailureCaptures,
  UltimateError,
  userActor,
} from '@ultimat3/core';
import { installFailureStore } from '@ultimat3/core/adapter';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { invoke } from './invoke';

const SECRET = '4111111111111111';
const pay = action({
  input: t.object({ cardPan: t.string.sensitive(), note: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: can('invoice:pay'),
  handle: () => {
    throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'planted', fix: 'x verify' });
  },
}).named('payInvoice');

const payer = ctxOf({
  actor: { ...userActor({ id: 'u1', orgId: 'o1' }), permissions: ['invoice:pay'] },
});
const saved: FailureBundle[] = [];

afterEach(() => {
  installFailureStore(null);
  saved.length = 0;
});

const run = async (raw: unknown): Promise<void> => {
  installFailureStore({ save: async (bundle) => void saved.push(bundle) });
  try {
    await invoke(pay, raw, { ctx: payer, surface: 'http' });
  } catch (error) {
    reportError(error, { source: 'http', scope: { operation: 'POST /api/pay-invoice' } });
  }
  await settleFailureCaptures();
};

test('a 5xx keeps the parsed input with its sensitive field masked and listed', async () => {
  await run({ cardPan: SECRET, note: 'march' });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.name).toBe('payInvoice');
  expect(saved[0]?.input).toEqual({ cardPan: REDACTED, note: 'march' });
  expect(saved[0]?.masked).toEqual(['cardPan']);
  expect(saved[0]?.actor?.id).toBe('u1');
  expect(JSON.stringify(saved)).not.toContain(SECRET);
});

test('an input the schema refuses is a 4xx and keeps nothing', async () => {
  await run({ cardPan: 1 });
  expect(saved).toEqual([]);
});
