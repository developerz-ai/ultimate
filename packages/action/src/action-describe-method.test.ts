// `describe().method` is the verb the route answers: a pin's `http.method`, else `POST`. It was the
// literal `'POST'`, so `x actions list --json` named a DELETE pin as a POST.

import { afterEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ActionHttp } from './http-path';
import { registerAction, resetActions } from './registry';

const declared = (http?: ActionHttp) =>
  registerAction(
    'removeOrder',
    action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('order:remove'),
      ...(http === undefined ? {} : { http }),
      handle: () => ({ ok: true }),
    }),
  );

afterEach(() => {
  resetActions();
});

describe('describe().method', () => {
  test('a DELETE pin is described as DELETE', () => {
    expect(declared({ path: '/orders/:id', method: 'DELETE' }).describe().method).toBe('DELETE');
  });

  test('a pin with no method and no pin at all are POST', () => {
    expect(declared({ path: '/orders/:id' }).describe().method).toBe('POST');
    resetActions();
    expect(declared().describe().method).toBe('POST');
  });
});
