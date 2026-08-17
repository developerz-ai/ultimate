// A read is projected to `GET /_x/query/<kebab>`, so its input has to survive a query STRING —
// characters, no nesting, no null. `client.ts` encoded a nested object as `JSON.stringify(item)`
// and skipped a `null`, while `coerceQuery` has no inverse for either, so the typed client
// type-checked calls the server's own route then rejected. The declaration is where that stops.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { coerceQuery, t } from '@ultimat3/schema';
import { queryClientMethodFor } from './client';
import { query } from './query';
import { from } from './source';

interface Row {
  readonly id: string;
}

/** Named for the primitive, never `declare`: `declare(x);` at statement position is parsed as
 * an ambient TypeScript declaration and ELIDED, so the call this file exists to make never ran. */
const declareQuery = (input: Parameters<typeof query>[0]['input']) =>
  query({
    input,
    policy: can('feed:read'),
    sql: () => from<Row>('rows', []),
  });

const refusal = (input: Parameters<typeof query>[0]['input']): { code: string; cause: string } => {
  try {
    declareQuery(input);
    return { code: 'resolved', cause: '' };
  } catch (error) {
    return isUltimateError(error)
      ? { code: error.code, cause: error.cause }
      : { code: String(error), cause: '' };
  }
};

describe('an input a query string cannot carry is refused where it is declared', () => {
  test('a nested object names the offending key', () => {
    const denied = refusal(
      t.object({ orgId: t.uuid, filter: t.object({ status: t.string, limit: t.number }) }),
    );
    expect(denied.code).toBe('X_QUERY_INPUT_UNENCODABLE');
    expect(denied.cause).toContain('filter');
  });

  test('a record, a money value and an array of objects are the same refusal', () => {
    for (const input of [
      t.object({ tags: t.record(t.string) }),
      t.object({ price: t.money }),
      t.object({ rows: t.array(t.object({ a: t.string })) }),
    ]) {
      expect(refusal(input).code).toBe('X_QUERY_INPUT_UNENCODABLE');
    }
  });

  test('a REQUIRED nullable key is refused — a query string has no null to send', () => {
    expect(refusal(t.object({ since: t.nullable(t.date) })).code).toBe('X_QUERY_INPUT_UNENCODABLE');
  });

  test('optional or defaulted, a nullable key is fine — absence is what the client sends', () => {
    expect(refusal(t.object({ since: t.nullable(t.date).optional() })).code).toBe('resolved');
    expect(refusal(t.object({ since: t.nullable(t.date).default(null) })).code).toBe('resolved');
  });

  test('an input that is not an object at all carries nothing — searchOf answers ""', () => {
    expect(refusal(t.string).code).toBe('X_QUERY_INPUT_UNENCODABLE');
  });

  test('a schema this package cannot introspect is left alone, never guessed at', () => {
    const foreign = {
      '~standard': {
        version: 1 as const,
        vendor: 'other',
        validate: (value: unknown) => ({ value }),
      },
    };
    expect(refusal(foreign).code).toBe('resolved');
  });
});

/** The URL the typed client actually builds, so the encoder under test is the shipped one. */
const wireFor = async (called: unknown): Promise<URLSearchParams> => {
  let url = '';
  const method = queryClientMethodFor('feed', {
    baseUrl: 'http://x',
    fetch: async (input) => {
      url = input;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    },
  });
  await method(called as never);
  return new URL(url).searchParams;
};

describe('every input the declaration allows round-trips through the wire', () => {
  const input = t.object({
    orgId: t.uuid,
    title: t.string,
    limit: t.number.int(),
    live: t.boolean,
    since: t.date,
    status: t.enum(['draft', 'published']),
    tags: t.array(t.string),
    cursor: t.string.optional(),
    page: t.number.default(1),
  });

  test('the client URL -> coerceQuery -> parse gives back what the caller passed', async () => {
    const called = {
      orgId: '00000000-0000-4000-8000-000000000001',
      title: 'hello world',
      limit: 25,
      live: true,
      since: '2026-02-01T00:00:00.000Z',
      status: 'draft' as const,
      tags: ['a', 'b'],
    };
    const parsed = input.parse(coerceQuery(input, await wireFor(called)));

    expect(parsed.orgId).toBe(called.orgId);
    expect(parsed.title).toBe(called.title);
    expect(parsed.limit).toBe(25);
    expect(parsed.live).toBe(true);
    expect(parsed.since.toISOString()).toBe(called.since);
    expect(parsed.status).toBe('draft');
    expect(parsed.tags).toEqual(['a', 'b']);
    // Omitted on the wire, so the schema's own answers stand — never `undefined` for a default.
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.page).toBe(1);
  });

  test('a one-element array is still an array on the far side', async () => {
    // `URLSearchParams` cannot tell one repeat from a scalar; `coerceQuery` reads the node.
    expect(coerceQuery(input, await wireFor({ tags: ['only'] }))['tags']).toEqual(['only']);
  });
});
