// The record envelope on the wire, proven over the real pipeline: an action whose output schema
// references an entity row answers `{ data, records }` under `x-ultimate-records: 1`, and an
// action whose output does not is byte-identical to what it answered before the envelope existed.

import { afterAll, describe, expect, test } from 'bun:test';
import { RECORDS_HEADER } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { toOpenApiOperation, toRoute } from './http';
import { outputSchemaName, schemaRef } from './naming';

const posts = entity('record_wire_posts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

afterAll(() => {
  clearRegistry();
});

const POST = { id: '00000000-0000-7000-8000-0000000000aa', title: 'hello' };
const Input = t.object({ postId: t.uuid });

const renamePost = action({
  input: Input,
  output: posts.$schema,
  policy: allow(),
  handle: () => POST,
}).named('renamePost');

const findPost = action({
  input: Input,
  output: t.object({ post: posts.$schema.nullable() }),
  policy: allow(),
  handle: () => ({ post: null }),
}).named('findPost');

const countPosts = action({
  input: Input,
  output: t.object({ id: t.uuid, title: t.string }),
  policy: allow(),
  handle: () => POST,
}).named('countPosts');

async function call(target: AnyAction): Promise<Response> {
  const server = createServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => null },
  });
  return server.fetch(
    new Request(`http://dev.test${toRoute(target).path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify({ postId: POST.id }),
    }),
  );
}

describe('the record envelope on an action route', () => {
  test('an output that IS an entity row answers the envelope, named by the header', async () => {
    const response = await call(renamePost);

    expect(response.status).toBe(200);
    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    expect(await response.json()).toEqual({
      data: POST,
      records: { record_wire_posts: { [POST.id]: POST } },
    });
  });

  test('an output that only MAY carry a row is enveloped when it carries none', async () => {
    // Decided per action from the schema, never per response from the data: one operation has
    // one wire shape, so a client never guesses which one it got.
    const response = await call(findPost);

    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    expect(await response.json()).toEqual({ data: { post: null }, records: {} });
  });

  test('an output with no entity row is byte-identical, and carries no header', async () => {
    // Same keys, same values as the row — a look-alike is not a record without the brand.
    const response = await call(countPosts);

    expect(response.headers.has(RECORDS_HEADER)).toBe(false);
    expect(await response.text()).toBe(JSON.stringify(POST));
  });
});

describe('the record envelope in the OpenAPI operation', () => {
  test('documents `records` as a required sibling of the output — the encoder always writes it — and the header', () => {
    const ok = toOpenApiOperation(renamePost).responses['200'] as Record<string, unknown>;

    expect(ok['headers']).toHaveProperty([RECORDS_HEADER, 'required'], true);
    expect(ok['content']).toHaveProperty(
      ['application/json', 'schema', 'required'],
      ['data', 'records'],
    );
    expect(ok['content']).toHaveProperty(
      ['application/json', 'schema', 'properties', 'data', '$ref'],
      schemaRef(outputSchemaName('renamePost')),
    );
    // Keyed by type, then by record key — the browser cannot compute a key without the app's
    // entity declarations, so the key is what travels.
    expect(ok['content']).toHaveProperty(
      ['application/json', 'schema', 'properties', 'records', 'additionalProperties'],
      { type: 'object', additionalProperties: { type: 'object' } },
    );
  });

  test('an operation with no entity row keeps the exact bytes it always had', () => {
    expect(toOpenApiOperation(countPosts).responses['200']).toEqual({
      description: 'ok',
      content: {
        'application/json': { schema: { $ref: schemaRef(outputSchemaName('countPosts')) } },
      },
    });
  });
});
