// `compileOpenApi` following a `$ref` into `#/components/<section>/<name>` for a parameter, a
// request body and a response — the shapes a hand-written document reuses most — and refusing a
// reference it cannot follow (a missing component, another file) with the pointer that holds it.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { compileOpenApi } from './openapi-compile';

const ORDER = { $ref: '#/components/schemas/Order' };
const components = {
  schemas: {
    Order: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
  requestBodies: { NewOrder: { content: { 'application/json': { schema: ORDER } } } },
  responses: {
    OrderOk: { description: 'ok', content: { 'application/json': { schema: ORDER } } },
  },
};
const documentWith = (operation: unknown) => ({
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  components,
  paths: { '/orders': { post: { operationId: 'createOrder', ...(operation as object) } } },
});

const refusalOf = (document: unknown): string => {
  try {
    compileOpenApi(document, { source: 'shop.json', only: undefined });
  } catch (error) {
    return isUltimateError(error) ? `${error.code} ${error.cause}` : `not coded: ${String(error)}`;
  }
  return expect.unreachable('a $ref the compiler cannot follow compiled');
};

describe('compileOpenApi $ref into components', () => {
  test('a parameter, a request body and a response are each read through their component', () => {
    const compiled = compileOpenApi(
      documentWith({
        parameters: [{ $ref: '#/components/parameters/Limit' }],
        requestBody: { $ref: '#/components/requestBodies/NewOrder' },
        responses: { '200': { $ref: '#/components/responses/OrderOk' } },
      }),
      { source: 'shop.json', only: undefined },
    );
    expect(compiled.operations[0]).toMatchObject({
      name: 'createOrder',
      parameters: [
        { name: 'limit', in: 'query', required: false, type: { kind: 'number', integer: true } },
      ],
      body: { type: { kind: 'ref', name: 'Order' } },
      response: { kind: 'ref', name: 'Order' },
    });
    expect([...compiled.types.keys()]).toEqual(['Order']);
  });

  test('a component that does not exist is refused at the $ref that names it', () => {
    const cause = refusalOf(
      documentWith({ responses: { '200': { $ref: '#/components/responses/Missing' } } }),
    );
    expect(cause).toStartWith('X_CLIENT_SPEC_UNSUPPORTED');
    expect(cause).toContain('#/components/responses/Missing');
    expect(cause).toContain('#/paths/~1orders/post/responses/200/$ref');
  });

  test('a reference into another file is refused, not fetched', () => {
    const cause = refusalOf(documentWith({ responses: { '200': { $ref: 'other.json#/Order' } } }));
    expect(cause).toStartWith('X_CLIENT_SPEC_UNSUPPORTED');
    expect(cause).toContain('the $ref other.json#/Order');
  });
});
