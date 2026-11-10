// The pins a rendered document stamps: every registered action and query that declares
// `http: { path }`, by name — and nothing at all for an app that pins none.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { allow } from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { servedPins } from './page-pins';

afterEach(() => {
  resetActions();
  resetQueries();
});

const write = (http?: { path: string; method: 'PUT' }) =>
  action({
    input: t.object({ id: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: allow('order:refund'),
    ...(http === undefined ? {} : { http }),
    handle: () => ({ ok: true }),
  });

const read = (http?: { path: string }) =>
  query({
    input: t.object({ id: t.string }),
    policy: allow('order:read'),
    ...(http === undefined ? {} : { http }),
    sql: ({ id }) => from<{ id: string }>('orders', []).where({ id }).orderBy('id'),
  });

describe('servedPins', () => {
  test('an app that pins nothing has no pins to stamp', () => {
    registerAction('likePost', write());
    registerQuery('listOrders', read());
    expect(servedPins()).toEqual({ actions: {}, queries: {} });
  });

  test('every pinned action and query, by its registered name, with the action verb', () => {
    registerAction('likePost', write());
    registerAction('refundOrder', write({ path: '/orders/:id/refund', method: 'PUT' }));
    registerQuery('orderById', read({ path: '/orders/:id' }));
    expect(servedPins()).toEqual({
      actions: { refundOrder: { path: '/orders/:id/refund', method: 'PUT' } },
      queries: { orderById: '/orders/:id' },
    });
  });
});
