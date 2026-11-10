// `ActionFact.http` / `QueryFact.http` and `.errors`: written exactly when declared, and a moved
// pin or a withdrawn declared code is a breaking change `contract-diff` reports.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { action, resetActions, t } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { defineError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { fixtureAction, fixtureQuery } from './diff-fixture';
import { diffActions, diffQueries } from './diff-operations';
import { frameworkSources } from './sources';

const ok = t.object({ ok: t.boolean });

const Late = defineError({
  code: 'X_MANIFEST_FIXTURE_LATE',
  title: 'manifest sources fixture: too late',
  status: 409,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});
const Gone = defineError({
  code: 'X_MANIFEST_FIXTURE_GONE',
  title: 'manifest sources fixture: gone',
  status: 410,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

beforeAll(() => {
  resetActions();
  resetQueries();
  registerAction(
    'refundOrder',
    action({
      input: t.object({ id: t.string }),
      output: ok,
      policy: allow('order:refund'),
      http: { path: '/orders/:id/refund', method: 'PUT' },
      errors: [Late.code, Gone.code],
      handle: () => ({ ok: true }),
    }),
  );
  registerAction(
    'publishOrder',
    action({
      input: t.object({}),
      output: ok,
      policy: allow('order:publish'),
      handle: () => ({ ok: true }),
    }),
  );
  registerQuery(
    'orderById',
    query({
      input: t.object({ id: t.string }),
      policy: allow('order:read'),
      http: { path: '/orders/:id' },
      errors: [Gone.code],
      sql: () => from<{ id: string }>('orders', []).orderBy('id'),
    }),
  );
});

afterAll(() => {
  resetActions();
  resetQueries();
});

describe('the http fact', () => {
  test('written for a pin, absent for a static action', () => {
    const sources = frameworkSources({ app: { name: 'acme', version: '1.0.0' } });
    const byName = new Map((sources.actions ?? []).map((fact) => [fact.name, fact]));
    expect(byName.get('refundOrder')?.http).toEqual({ path: '/orders/:id/refund', method: 'PUT' });
    expect(Object.hasOwn(byName.get('publishOrder') ?? {}, 'http')).toBe(false);
    expect(sources.queries?.find((fact) => fact.name === 'orderById')?.http).toEqual({
      path: '/orders/:id',
      method: 'GET',
    });
  });

  test('POST to PUT on a pin is breaking; a pin appearing is additive; withdrawn is breaking', () => {
    const at = (method: string) => ({
      ...fixtureAction('refundOrder', 'order:refund'),
      http: { path: '/orders/:id/refund', method },
    });
    expect(diffActions([at('POST')], [at('PUT')])).toEqual([
      { kind: 'breaking', path: 'actions.refundOrder.http', detail: expect.any(String) },
    ]);
    const bare = fixtureAction('refundOrder', 'order:refund');
    expect(diffActions([bare], [at('POST')])).toEqual([
      { kind: 'additive', path: 'actions.refundOrder.http', detail: expect.any(String) },
    ]);
    expect(diffActions([at('POST')], [bare])).toEqual([
      { kind: 'breaking', path: 'actions.refundOrder.http', detail: expect.any(String) },
    ]);
    expect(diffActions([at('POST')], [at('POST')])).toEqual([]);
  });

  test("a query's moved pin is breaking", () => {
    const at = (path: string) => ({
      ...fixtureQuery('orderById', 'order:read'),
      http: { path, method: 'GET' },
    });
    expect(diffQueries([at('/orders/:id')], [at('/v2/orders/:id')])).toEqual([
      { kind: 'breaking', path: 'queries.orderById.http', detail: expect.any(String) },
    ]);
  });
});

describe('the errors fact', () => {
  test('written sorted when declared, absent when not', () => {
    const sources = frameworkSources({ app: { name: 'acme', version: '1.0.0' } });
    const byName = new Map((sources.actions ?? []).map((fact) => [fact.name, fact]));
    expect(byName.get('refundOrder')?.errors).toEqual([Gone.code, Late.code]);
    expect(Object.hasOwn(byName.get('publishOrder') ?? {}, 'errors')).toBe(false);
    expect(sources.queries?.find((fact) => fact.name === 'orderById')?.errors).toEqual([Gone.code]);
  });

  test('contract-diff: a removed declared code is breaking, on an action and a query', () => {
    const act = (errors: string[]) => ({ ...fixtureAction('refundOrder', 'order:refund'), errors });
    expect(diffActions([act(['X_A', 'X_B'])], [act(['X_A'])])).toEqual([
      { kind: 'breaking', path: 'actions.refundOrder.errors.X_B', detail: expect.any(String) },
    ]);
    const read = (errors: string[]) => ({ ...fixtureQuery('orderById', 'order:read'), errors });
    expect(diffQueries([read(['X_A'])], [read([])])).toEqual([
      { kind: 'breaking', path: 'queries.orderById.errors.X_A', detail: expect.any(String) },
    ]);
  });
});
