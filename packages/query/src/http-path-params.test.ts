// A read pinned at `http: { path: '/orders/:id' }`: served there and not at `/_x/query/<kebab>`,
// the URL's value joining the search string as the one input, a disagreement refused, the
// OpenAPI operation naming the param `in: path`, and `client()` filling the URL.

import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { queryOpenApiPaths } from './openapi';
import { query } from './query';
import { from } from './source';

interface Order {
  readonly id: string;
  readonly status: string;
}

const orders: readonly Order[] = [
  { id: 'o-1', status: 'open' },
  { id: 'a/b', status: 'shipped' },
];

const orderById = () =>
  query({
    input: t.object({ id: t.string, status: t.string.optional() }),
    policy: allow('order:read'),
    single: true,
    http: { path: '/orders/:id' },
    sql: ({ id }) => from<Order>('orders', orders).where({ id }).orderBy('id'),
  }).named('orderById');

const serve = () =>
  httpServer({
    routes: [toQueryRoute(orderById())],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const get = (path: string) => serve().fetch(new Request(`http://app.test${path}`));

describe('a pinned read over HTTP', () => {
  test('GET /orders/:id answers the row the URL names', async () => {
    const response = await get('/orders/o-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'o-1', status: 'open' });
  });

  test('an encoded a%2Fb stays one value', async () => {
    expect(await (await get('/orders/a%2Fb')).json()).toEqual({ id: 'a/b', status: 'shipped' });
  });

  test('the pin replaces the derived URL', async () => {
    expect(toQueryRoute(orderById()).path).toBe('/orders/:id');
    expect((await get('/_x/query/order-by-id?id=o-1')).status).toBe(404);
  });

  test('the search string naming :id differently is 400 X_HTTP_PATH_INPUT_CONFLICT', async () => {
    const response = await get('/orders/o-1?id=a%2Fb');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('X_HTTP_PATH_INPUT_CONFLICT');
    expect((await get('/orders/o-1?id=o-1')).status).toBe(200);
  });
});

describe('the declaration', () => {
  test.each([
    ['a :param that is not an input key', { path: '/orders/:orderId' }],
    ['a :param naming an optional key', { path: '/orders/:status' }],
    ['a path under /_x', { path: '/_x/orders/:id' }],
    ['a method other than GET', { path: '/orders/:id', method: 'POST' }],
    ['a method with no path', { method: 'GET' }],
  ])('%s is X_QUERY_HTTP_PATH_INVALID', (_reason, http) => {
    expect(() =>
      query({
        input: t.object({ id: t.string, status: t.string.optional() }),
        policy: allow('order:read'),
        http: http as never,
        sql: () => from<Order>('orders', orders).orderBy('id'),
      }),
    ).toThrow(expect.objectContaining({ code: 'X_QUERY_HTTP_PATH_INVALID' }));
  });
});

describe('the OpenAPI operation', () => {
  test('{id} is in: path and required, and leaves the query parameters', () => {
    const paths = queryOpenApiPaths([orderById()]);
    expect(Object.keys(paths)).toEqual(['/orders/{id}']);
    const operation = paths['/orders/{id}']?.['get'] as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(
      operation.parameters.map(({ name, in: where, required }) => ({ name, in: where, required })),
    ).toEqual([
      { name: 'id', in: 'path', required: true },
      { name: 'status', in: 'query', required: false },
    ]);
  });
});

describe('client()', () => {
  test('fills the URL, encodes the value, and keeps the key out of the search string', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ id: 'a/b', status: 'shipped' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    await orderById().client({ baseUrl: 'http://app.test', fetch })({ id: 'a/b', status: 'x' });
    expect(urls).toEqual(['http://app.test/orders/a%2Fb?status=x']);
  });

  test('a missing value is refused before anything is sent', async () => {
    const fetch: FetchLike = async () => expect.unreachable('nothing may be sent');
    try {
      await orderById().client({ baseUrl: 'http://app.test', fetch })({ id: '' });
      expect.unreachable('an empty :id must be refused');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: 'X_QUERY_HTTP_PATH_INVALID' }));
    }
  });
  test("a dot-segment value is refused, and the refusal says why rather than 'missing'", async () => {
    const fetch: FetchLike = async () => expect.unreachable('nothing may be sent');
    try {
      await orderById().client({ baseUrl: 'http://app.test', fetch })({ id: '..' });
      expect.unreachable('a :id of .. must be refused');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: 'X_QUERY_HTTP_PATH_INVALID' }));
      expect(String((error as { cause?: unknown }).cause)).toContain(':id is');
      expect(String((error as { cause?: unknown }).cause)).toContain('dot-segment');
    }
  });
});
