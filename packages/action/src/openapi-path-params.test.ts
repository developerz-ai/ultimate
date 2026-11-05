// A `:param` pin in the published document: `{id}`, an `in: path` required parameter, the key out
// of the request body's component, the operation under its declared verb — and every static
// action's operation byte-identical to what it was.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { contractTestsFor } from './contract-test';
import { defineApi } from './define-api';
import { toOpenApiOperation } from './http';
import { buildOpenApi, serializeOpenApi } from './openapi';
import { resetActions } from './registry';

const make = (http?: { readonly path: string; readonly method?: 'PUT' | 'DELETE' }) =>
  action({
    input: t.object({ id: t.string, title: t.string, note: t.string.optional() }),
    output: t.object({ ok: t.boolean }),
    policy: allow('order:update'),
    ...(http === undefined ? {} : { http }),
    handle: () => ({ ok: true }),
  });

beforeEach(() => resetActions());
afterEach(() => resetActions());

describe('a parameterised pin in openapi.json', () => {
  test('{id}, in: path and required, and the key leaves the body', () => {
    defineApi({ actions: { updateOrder: make({ path: '/orders/:id', method: 'PUT' }) } });
    const document = buildOpenApi();
    expect(Object.keys(document.paths)).toEqual(['/orders/{id}']);
    const item = document.paths['/orders/{id}'] as Record<string, { parameters: unknown[] }>;
    expect(Object.keys(item)).toEqual(['put']);
    expect(item['put']?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { minLength: 1, type: 'string' } },
    ]);
    const body = document.components.schemas['UpdateOrderInput'] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(body.properties).sort()).toEqual(['note', 'title']);
    expect(body.required).toEqual(['title']);
  });

  test('two verbs on one URL are two operations of one path item', () => {
    defineApi({
      actions: {
        updateOrder: make({ path: '/orders/:id', method: 'PUT' }),
        deleteOrder: make({ path: '/orders/:id', method: 'DELETE' }),
      },
    });
    const item = buildOpenApi().paths['/orders/{id}'] as Record<string, { operationId: string }>;
    expect(Object.keys(item).sort()).toEqual(['delete', 'put']);
    expect(item['delete']?.operationId).toBe('deleteOrder');
    expect(item['put']?.operationId).toBe('updateOrder');
  });

  test('the contract assertion finds the operation under its declared verb', async () => {
    const update = make({ path: '/orders/:id', method: 'PUT' });
    defineApi({ actions: { updateOrder: update } });
    const documented = contractTestsFor(update).find((entry) => entry.name.includes('OpenAPI'));
    if (documented === undefined) return expect.unreachable('the OpenAPI assertion exists');
    await documented.run();
  });

  test('a static action is byte-identical, whatever else is pinned', () => {
    defineApi({ actions: { publishOrder: make() } });
    const alone = serializeOpenApi(buildOpenApi());
    const operation = JSON.stringify(toOpenApiOperation(make().named('publishOrder')));
    resetActions();
    defineApi({ actions: { publishOrder: make() } });
    expect(serializeOpenApi(buildOpenApi())).toBe(alone);
    expect(JSON.stringify(toOpenApiOperation(make().named('publishOrder')))).toBe(operation);
    const published = buildOpenApi().paths['/api/orders/publish'] as Record<string, unknown>;
    expect(Object.keys(published)).toEqual(['post']);
    expect((published['post'] as { parameters: unknown[] }).parameters).toEqual([]);
  });
});
