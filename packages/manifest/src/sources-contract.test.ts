// The contract facts a read, a mount and a consumer publish, projected from the REAL registries: a `rows:`
// the same wire schema the OpenAPI document and the MCP tool carry, a mount only what a token
// reaches. A registry of its own, so the sibling `sources.test.ts`'s exact name lists stay exact.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { defineApi, resetActions, t } from '@ultimat3/action';
import { clearRegistry as clearEntities, entity, text, uuid } from '@ultimat3/entity';
import { consumer, resetJobs, resetTasks } from '@ultimat3/jobs';
import { allow } from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { toWireOutputSchema } from '@ultimat3/schema';
import { buildManifest } from './build';
import { manifestJson } from './emit';
import { frameworkSources } from './sources';

const APP = { name: 'acme', version: '1.0.0' } as const;
const Row = t.object({ id: t.string, title: t.string.optional() });

const secrets = entity('sc_secrets', {
  columns: { id: uuid().primaryKey(), title: text(), credential: text().sealed() },
});

const read = (rows?: StandardSchemaV1<unknown, { id: string }>) =>
  query({
    input: t.object({}),
    policy: allow('public'),
    ...(rows === undefined ? {} : { rows }),
    sql: () => from<{ id: string }>('sc_rows', []).orderBy('id'),
  });

const fact = (name: string) =>
  frameworkSources({ app: APP }).queries?.find((candidate) => candidate.name === name);

beforeAll(() => {
  resetQueries();
});

beforeEach(() => {
  resetActions();
});

afterEach(() => {
  resetActions();
  resetQueries();
});

afterAll(() => {
  clearEntities();
});

describe('QueryFact.rows', () => {
  test('a declared row is the wire schema, the same object the other surfaces publish', () => {
    registerQuery('typedRead', read(Row));
    expect(JSON.stringify(fact('typedRead')?.rows)).toBe(JSON.stringify(toWireOutputSchema(Row)));
    expect(fact('typedRead')?.rows).toEqual({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, title: { type: 'string' } },
    });
  });

  test('none declared writes no key — like `subscribes`, absence carries the whole meaning', () => {
    registerQuery('plainRead', read());
    expect('rows' in (fact('plainRead') ?? {})).toBe(false);
  });

  test('a row that cannot be introspected writes no key rather than a guess', () => {
    const foreign = {
      '~standard': {
        version: 1 as const,
        vendor: 'foreign',
        validate: (value: unknown) => ({ value: value as { id: string } }),
      },
    };
    registerQuery('foreignRead', read(foreign));
    expect('rows' in (fact('foreignRead') ?? {})).toBe(false);
  });

  test('a sealed column is absent from the fact', () => {
    registerQuery('secretRead', read(secrets.$schema));
    const text = JSON.stringify(fact('secretRead')?.rows);
    expect(text).toContain('title');
    expect(text).not.toContain('credential');
  });
});

describe('Manifest.mounts', () => {
  const mount = {
    prefix: '/v1',
    scopes: { 'run:write': ['startRun'], 'run:read': ['listRuns'] },
    resolveToken: () => null,
    openapi: 'openapi.v1.json',
    rateLimit: { limit: 10, windowMs: 1000 },
  };

  test('the prefix and the cut, and nothing a token holder cannot see', () => {
    defineApi({ http: { mounts: [mount] } });
    const sources = frameworkSources({ app: APP });
    expect(sources.mounts).toEqual([{ prefix: '/v1', scopes: mount.scopes }]);
    const written = manifestJson(buildManifest(sources));
    expect(written).toContain('"/v1"');
    expect(written).not.toContain('resolveToken');
    expect(written).not.toContain('openapi.v1.json');
  });

  test('an app that declared none has no section', () => {
    expect(frameworkSources({ app: APP }).mounts).toEqual([]);
    expect(manifestJson(buildManifest(frameworkSources({ app: APP })))).not.toContain('mounts');
  });
});

describe('Manifest.consumers', () => {
  afterEach(() => {
    resetJobs();
    resetTasks();
  });

  test('one row per consumer(), naming its supervisor and arm, and no function', () => {
    consumer<number, number>({
      name: 'scFeed',
      tenant: 'none',
      keys: () => ['only'],
      open: async function* () {},
      handle: () => 0,
      cursor: { load: () => null, save: () => undefined },
      rearm: '5m',
      batch: 25,
    });
    const sources = frameworkSources({ app: APP });
    expect(sources.consumers).toEqual([
      {
        name: 'scFeed',
        queue: 'default',
        supervisor: 'scFeed.supervisor',
        arm: 'scFeed.arm',
        rearm: '*/5 * * * *',
        batch: 25,
        lags: false,
      },
    ]);
    expect(manifestJson(buildManifest(sources))).toContain('"consumers"');
  });

  test('an app that declared none has no section', () => {
    expect(frameworkSources({ app: APP }).consumers).toEqual([]);
    expect(manifestJson(buildManifest(frameworkSources({ app: APP })))).not.toContain('consumers');
  });
});
