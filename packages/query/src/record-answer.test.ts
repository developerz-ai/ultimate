// The read's wire answer, over the real pipeline: the record envelope behind
// `x-ultimate-records: 1` whenever the query declares an entity's row schema — rows or none, one
// shape per operation — and the bare rows, byte-identical to before, in every other case.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  decodeRecordEnvelope,
  RECORDS_HEADER,
  RECORDS_OPENAPI_HEADER,
  recordEnvelopeSchema,
} from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { toQueryOpenApiOperation } from './openapi';
import type { AnyQuery } from './query';
import { query } from './query';
import { from } from './source';

const ORG = '00000000-0000-4000-8000-000000000001';
const POST_A = '00000000-0000-4000-8000-00000000000a';
const POST_B = '00000000-0000-4000-8000-00000000000b';

const Post = entity('query_record_answer_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 80 }) },
});
// A type alias, not an interface: only an alias is assignable to core's `Row` index signature.
type PostRow = { readonly id: string; readonly orgId: string; readonly title: string };

afterAll(() => {
  clearRegistry();
});

const [ROW_A, ROW_B]: readonly [PostRow, PostRow] = [
  { id: POST_A, orgId: ORG, title: 'a' },
  { id: POST_B, orgId: ORG, title: 'b' },
];
const stored: readonly PostRow[] = [ROW_A, ROW_B];
const Input = t.object({ orgId: t.uuid });

function feed(rows: readonly PostRow[], declared: boolean): AnyQuery {
  return query({
    input: Input,
    policy: allow('public'),
    ...(declared ? { rows: Post.$schema } : {}),
    sql: ({ orgId }) => from<PostRow>('posts', rows).where({ orgId }).orderBy('id'),
  }).named('recordFeed');
}

async function read(target: AnyQuery, search = `?orgId=${ORG}`): Promise<Response> {
  const server = createServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => null },
  });
  return server.fetch(new Request(`http://dev.test/_x/query/record-feed${search}`));
}

describe('the record envelope on a read', () => {
  test('an entity row schema with rows found answers the envelope, header set', async () => {
    const response = await read(feed(stored, true));

    expect(response.status).toBe(200);
    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    const envelope = decodeRecordEnvelope(await response.json());
    expect(envelope.data).toEqual(stored);
    const records = envelope.records ?? {};
    const types = Object.keys(records);
    expect(types).toHaveLength(1);
    // Keyed by record key: the browser cannot derive a key without importing the entity.
    expect(records[types[0] ?? '']).toEqual({ [POST_A]: ROW_A, [POST_B]: ROW_B });
  });

  test('a page answer carries the page as data and its rows as records', async () => {
    const response = await read(feed(stored, true), `?orgId=${ORG}&_first=1`);

    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    const envelope = decodeRecordEnvelope(await response.json());
    expect((envelope.data as { rows: unknown }).rows).toEqual([ROW_A]);
    expect(Object.values(envelope.records ?? {})).toEqual([{ [POST_A]: ROW_A }]);
  });

  test('no rows found is STILL the envelope, with empty records — one shape per operation', async () => {
    const response = await read(feed([], true));

    expect(response.headers.get(RECORDS_HEADER)).toBe('1');
    expect(await response.json()).toEqual({ data: [], records: {} });
  });

  test('a query declaring no row schema is byte-identical to before', async () => {
    const response = await read(feed(stored, false));

    expect(response.headers.get(RECORDS_HEADER)).toBeNull();
    expect(await response.text()).toBe(JSON.stringify(stored));
  });

  test('an unbranded row schema is not a record, so the wire is the bare rows', async () => {
    const Lookalike = t.object({ id: t.uuid, orgId: t.uuid, title: t.string });
    const target = query({
      input: Input,
      policy: allow('public'),
      rows: Lookalike,
      sql: ({ orgId }) => from<PostRow>('posts', stored).where({ orgId }).orderBy('id'),
    }).named('recordFeed');

    const response = await read(target);

    expect(response.headers.get(RECORDS_HEADER)).toBeNull();
    expect(await response.text()).toBe(JSON.stringify(stored));
  });
});

describe('the record envelope in the OpenAPI document', () => {
  const okOf = (target: AnyQuery): Record<string, unknown> => {
    const responses = toQueryOpenApiOperation(target)['responses'] as Record<string, unknown>;
    return responses['200'] as Record<string, unknown>;
  };
  const bodyOf = (ok: Record<string, unknown>): unknown => {
    const content = ok['content'] as Record<string, { schema: unknown }>;
    return content['application/json']?.schema;
  };
  const armsOf = (ok: Record<string, unknown>): readonly unknown[] => {
    const content = ok['content'] as Record<string, { schema: { oneOf: readonly unknown[] } }>;
    return content['application/json']?.schema.oneOf ?? [];
  };

  test('a read declaring an entity row schema documents the envelope and its header', () => {
    const ok = okOf(feed(stored, true));

    // The envelope IS the body — no `oneOf` over "sometimes" — and it is core's description.
    expect(bodyOf(ok)).toEqual(recordEnvelopeSchema({ oneOf: armsOf(okOf(feed(stored, false))) }));
    expect(ok['headers']).toEqual(RECORDS_OPENAPI_HEADER);
  });

  test('a read declaring none, or an unbranded look-alike, documents what it did before', () => {
    const lookalike = query({
      input: Input,
      policy: allow('public'),
      rows: t.object({ id: t.uuid, orgId: t.uuid, title: t.string }),
      sql: ({ orgId }) => from<PostRow>('posts', stored).where({ orgId }),
    }).named('recordFeed');

    for (const target of [feed(stored, false), lookalike]) {
      const ok = okOf(target);
      expect(armsOf(ok)).toHaveLength(2);
      expect(ok['headers']).toBeUndefined();
    }
  });
});
