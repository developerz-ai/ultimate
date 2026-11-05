// A pinned `http.path` with `:params` and a `method`: the URL's values reach the handler, the row
// loader and the schema as one input; a body that disagrees is refused; a bad template is refused
// at seating; two verbs share one URL.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { defineApi } from './define-api';
import { toRoute } from './http';
import type { ActionHttp } from './http-path';
import { derivePath } from './naming';
import { actionHttpPath, getAction, resetActions } from './registry';

const seen: unknown[] = [];
const rows: unknown[] = [];

const refund = (http: ActionHttp = { path: '/orders/:id/refund' }) =>
  action({
    input: t.object({ id: t.string, reason: t.string.optional() }),
    output: t.object({ ok: t.boolean }),
    policy: allow('order:refund'),
    http,
    row: ({ input }) => {
      rows.push(input.id);
      return { id: input.id };
    },
    handle: ({ input }) => {
      seen.push(input);
      return { ok: true };
    },
  });

beforeEach(() => {
  resetActions();
  seen.length = 0;
  rows.length = 0;
});
afterEach(() => resetActions());

const serve = (...names: string[]) =>
  httpServer({
    routes: names.map((name) => {
      const target = getAction(name);
      if (target === undefined) return expect.unreachable(`fixture: ${name} is not registered`);
      return toRoute(target);
    }),
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const send = (path: string, body: unknown, method = 'POST') =>
  new Request(`http://app.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('a parameterised pin over HTTP', () => {
  test('POST /orders/:id/refund reaches the handler and the row loader with input.id', async () => {
    defineApi({ actions: { refundOrder: refund() } });
    const response = await serve('refundOrder').fetch(send('/orders/o-1/refund', { reason: 'x' }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ id: 'o-1', reason: 'x' }]);
    expect(rows).toEqual(['o-1']);
  });

  test('the same value in the body is one value', async () => {
    defineApi({ actions: { refundOrder: refund() } });
    const response = await serve('refundOrder').fetch(send('/orders/o-1/refund', { id: 'o-1' }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ id: 'o-1' }]);
  });

  test('path and body disagreeing is a 400 X_HTTP_PATH_INPUT_CONFLICT, and nothing runs', async () => {
    defineApi({ actions: { refundOrder: refund() } });
    const response = await serve('refundOrder').fetch(send('/orders/o-1/refund', { id: 'o-2' }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('X_HTTP_PATH_INPUT_CONFLICT');
    expect(seen).toEqual([]);
    expect(rows).toEqual([]);
  });

  test('an encoded a%2Fb stays one value', async () => {
    defineApi({ actions: { refundOrder: refund() } });
    const response = await serve('refundOrder').fetch(send('/orders/a%2Fb/refund', {}));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ id: 'a/b' }]);
  });

  test('two verbs on one URL coexist, each its own action', async () => {
    const update = action({
      input: t.object({ id: t.string, title: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow('order:update'),
      http: { path: '/orders/:id', method: 'PUT' },
      handle: ({ input }) => {
        seen.push(['put', input]);
        return { ok: true };
      },
    });
    const remove = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow('order:delete'),
      http: { path: '/orders/:id', method: 'DELETE' },
      handle: ({ input }) => {
        seen.push(['delete', input]);
        return { ok: true };
      },
    });
    defineApi({ actions: { updateOrder: update, deleteOrder: remove } });
    const server = serve('updateOrder', 'deleteOrder');
    expect((await server.fetch(send('/orders/o-1', { title: 'T' }, 'PUT'))).status).toBe(200);
    expect((await server.fetch(send('/orders/o-1', {}, 'DELETE'))).status).toBe(200);
    expect(seen).toEqual([
      ['put', { id: 'o-1', title: 'T' }],
      ['delete', { id: 'o-1' }],
    ]);
  });

  test('two actions on one method and template are still the duplicate refusal', () => {
    expect(() => defineApi({ actions: { refundOrder: refund(), reRefund: refund() } })).toThrow(
      expect.objectContaining({ code: 'X_ACTION_PATH_DUPLICATE' }),
    );
  });
});

describe('seating refuses a template the input cannot fill', () => {
  test.each([
    ['a :param that is not an input key', { path: '/orders/:orderId/refund' }],
    ['a :param repeated', { path: '/orders/:id/lines/:id' }],
    ['an unknown method', { path: '/orders/:id/refund', method: 'GET' }],
    ['a method with no path', { method: 'PUT' }],
  ])('%s', (_reason, http) => {
    expect(() => defineApi({ actions: { refundOrder: refund(http as ActionHttp) } })).toThrow(
      expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }),
    );
  });

  test('a :param naming an optional key', () => {
    expect(() =>
      defineApi({ actions: { refundOrder: refund({ path: '/orders/:reason' }) } }),
    ).toThrow(expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }));
  });
});

describe('by name', () => {
  test('derivePath refuses a template it has no values for; actionHttpPath fills one', () => {
    defineApi({ actions: { refundOrder: refund() } });
    expect(() => derivePath('refundOrder')).toThrow(
      expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }),
    );
    expect(actionHttpPath('refundOrder', { id: 'a/b' }).path).toBe('/orders/a%2Fb/refund');
    expect(() => actionHttpPath('refundOrder', {})).toThrow(
      expect.objectContaining({ code: 'X_ACTION_HTTP_PATH_INVALID' }),
    );
  });

  test('a deprecation naming a parameterised successor is X_ACTION_DEPRECATION_INVALID', () => {
    const old = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow('order:refund'),
      deprecated: {
        since: '2026-11-01T00:00:00Z',
        sunset: '2027-01-01T00:00:00Z',
        replacedBy: 'refundOrder',
      },
      handle: () => ({ ok: true }),
    });
    defineApi({ actions: { refundOrder: refund(), oldRefund: old } });
    expect(() => serve('oldRefund')).toThrow(
      expect.objectContaining({
        code: 'X_ACTION_DEPRECATION_INVALID',
        meta: { action: 'oldRefund', field: 'replacedBy', value: 'refundOrder' },
      }),
    );
  });
});
