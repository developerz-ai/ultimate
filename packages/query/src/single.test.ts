// `single: true` — a read of one object. Over HTTP it answers that row or 404 `X_NOT_FOUND`,
// refuses the page controls, and documents one object; every in-process caller keeps the rows.
// Before it a detail URL for an id that did not exist answered `200 []`.

import { afterAll, describe, expect, test } from 'bun:test';
import { decodeRecordEnvelope, RECORDS_HEADER } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike, QueryClient, QueryClientMethod, QuerySingleClientMethod } from './client';
import { toQueryRoute } from './http';
import { toQueryOpenApiOperation } from './openapi';
import type { AnyQuery, Query } from './query';
import { query } from './query';
import { from } from './source';

const ORG = '00000000-0000-4000-8000-000000000001';
const POST_A = '00000000-0000-4000-8000-00000000000a';
const POST_B = '00000000-0000-4000-8000-00000000000b';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const Post = entity('query_single_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 80 }) },
});
type PostRow = { readonly id: string; readonly orgId: string; readonly title: string };
const ROW_A: PostRow = { id: POST_A, orgId: ORG, title: 'a' };
const stored: readonly PostRow[] = [ROW_A, { id: POST_B, orgId: ORG, title: 'b' }];

afterAll(() => {
  clearRegistry();
});

const Input = t.object({ id: t.uuid });

function postById(records = false) {
  return query({
    input: Input,
    policy: allow('public'),
    single: true,
    ...(records ? { rows: Post.$schema } : {}),
    sql: ({ id }) => from<PostRow>('posts', stored).where({ id }).limit(1),
  }).named('postById');
}

function serve(target: AnyQuery) {
  return createServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => null },
  });
}

const get = (target: AnyQuery, search: string): Promise<Response> =>
  serve(target).fetch(new Request(`http://dev.test/_x/query/post-by-id${search}`));

describe('a single read over the route', () => {
  test('answers the row itself, not a one-row array', async () => {
    const response = await get(postById(), `?id=${POST_A}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ROW_A);
  });

  test('no row is 404 X_NOT_FOUND — where a list read answers 200 []', async () => {
    const response = await get(postById(), `?id=${MISSING}`);
    const body = (await response.json()) as { code?: string; fix?: string };
    expect(response.status).toBe(404);
    expect(body.code).toBe('X_NOT_FOUND');
    expect(body.fix).toContain('x queries describe postById');
  });

  test('a page control is refused as a 400, never silently dropped', async () => {
    for (const search of [`?id=${POST_A}&_first=5`, `?id=${POST_A}&_after=abc`]) {
      const response = await get(postById(), search);
      expect([search, response.status]).toEqual([search, 400]);
      expect(((await response.json()) as { code?: string }).code).toBe('X_INPUT_INVALID');
    }
  });

  test('an entity row schema answers the envelope with the row as data', async () => {
    const response = await get(postById(true), `?id=${POST_A}`);
    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    const envelope = decodeRecordEnvelope(await response.json());
    expect(envelope.data).toEqual(ROW_A);
    expect(Object.values(envelope.records ?? {})).toEqual([{ [POST_A]: ROW_A }]);
  });

  test('a list read is untouched: no row is still 200 []', async () => {
    const list = query({
      input: Input,
      policy: allow('public'),
      sql: ({ id }) => from<PostRow>('posts', stored).where({ id }),
    }).named('postById');
    const response = await get(list, `?id=${MISSING}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

describe('a single read in process', () => {
  test('keeps the rows every caller already reads `[0]` off', async () => {
    const read = postById();
    // `.as(null, …)` is `read(input)` with a context installed — the same read path.
    expect(await read.as(null, { id: POST_A })).toEqual([ROW_A]);
    expect(await read.as(null, { id: MISSING })).toEqual([]);
    expect(read.single).toBe(true);
  });

  test('a declaration that is not a boolean is refused where it is written', () => {
    expect(() =>
      query({
        input: Input,
        policy: allow('public'),
        single: 'yes' as unknown as boolean,
        sql: () => from<PostRow>('posts', stored),
      }),
    ).toThrow('X_QUERY_SINGLE_INVALID');
  });
});

describe('the typed client of a single read', () => {
  const target = postById();
  const server = serve(target);
  const fetchLike: FetchLike = (input, init) => server.fetch(new Request(input, init));
  const call = target.client({ baseUrl: 'http://dev.test', fetch: fetchLike });

  test('answers the row, and rejects with the server’s X_NOT_FOUND', async () => {
    const row: PostRow = await call({ id: POST_A });
    expect(row).toEqual(ROW_A);
    await expect(call({ id: MISSING })).rejects.toThrow('X_NOT_FOUND');
  });

  test('is typed as one row with no page, in both client spellings', () => {
    // Compile-time: `tsc -b` fails if either projection still types the answer as rows.
    type Mapped = QueryClient<{ postById: typeof target; postList: Query<typeof Input, PostRow> }>;
    const one: QuerySingleClientMethod<typeof Input, PostRow> = call;
    const mapped: Mapped['postById'] = one;
    const listed: QueryClientMethod<typeof Input, PostRow> | undefined = undefined as
      | Mapped['postList']
      | undefined;
    // @ts-expect-error — a single read's method has no `page`; the route would refuse it (400).
    mapped.page;
    expect(listed).toBeUndefined();
  });
});

describe('the OpenAPI operation of a single read', () => {
  const operation = toQueryOpenApiOperation(postById()) as {
    parameters: readonly { name: string }[];
    responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    'x-ultimate': { single?: boolean };
  };

  test('documents one object and a 404, and no page controls', () => {
    expect(operation.parameters.map((parameter) => parameter.name)).toEqual(['id']);
    expect(operation.responses['200']?.content?.['application/json']?.schema).toEqual({
      type: 'object',
    });
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '403', '404']);
    expect(operation['x-ultimate'].single).toBe(true);
  });

  test('a list read still advertises _first and _after, and no 404', () => {
    const list = toQueryOpenApiOperation(
      query({
        input: Input,
        policy: allow('public'),
        sql: () => from<PostRow>('posts', stored),
      }).named('postList'),
    ) as { parameters: readonly { name: string }[]; responses: Record<string, unknown> };
    expect(list.parameters.map((parameter) => parameter.name)).toEqual(['id', '_first', '_after']);
    expect(list.responses['404']).toBeUndefined();
  });
});
