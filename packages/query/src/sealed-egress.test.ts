// One assertion per way a `query` hands rows out of the process: the HTTP answer (list, page,
// single, record envelope), the MCP read, a live window's first rows, and the shared cache tier.
// A query has NO output parse, so nothing here strips a column — the rows themselves must not
// carry a sealed value anywhere a serialiser looks. The loader returns repository rows whole,
// exactly as an app's `sql:` does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CacheSetOptions, CacheTier } from '@ultimat3/cache';
import { declareTags, isolateDeclaredTags, isolateTiers, registerTier, tag } from '@ultimat3/cache';
import { anonymousActor, createContext, isUltimateError, runWithContext } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { toQueryTool } from './mcp-tool';
import type { AnyQuery } from './query';
import { query } from './query';
import { from } from './source';

/** Recognisable in any body, header or stored entry. */
const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';
/** A stored value's prefix: a sealed STRING leaving is a leak too — the slice says omitted. */
const SEALED = /x1\.[0-9a-f]{16}\./;

// `credential` and `contact`, not `password`/`token`: no name-based redaction may be what holds.
const accounts = entity('qe_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    credential: text().sealed(),
    contact: text().sealed({ lookup: true }),
  },
});
type Account = typeof accounts.$row;

entity('qe_labels', { columns: { id: uuid().primaryKey(), label: text() } });

const table = database({ accounts }, { driver: memoryDriver() }).accounts;
const restoreTags = isolateDeclaredTags();
let id = '';

beforeAll(async () => {
  declareTags(['qe_accounts']);
  const made = await table.insert({ name: 'Ada', credential: CANARY, contact: LOOKUP_CANARY });
  id = made.id;
});

afterAll(() => {
  restoreTags();
  clearRegistry();
});

const Input = t.object({ name: t.string.optional() });

/** The read an app writes: repository rows, whole, through `from()`. */
const list = (extra: { rows?: boolean; single?: boolean; cached?: boolean } = {}): AnyQuery =>
  query({
    input: Input,
    policy: allow('public'),
    mcp: { expose: true },
    ...(extra.single === true ? { single: true } : {}),
    ...(extra.rows === true ? { rows: accounts.$schema } : {}),
    ...(extra.cached === true ? { cache: { tags: [tag('qe_accounts')], ttlMs: 60_000 } } : {}),
    sql: () => from<Account>('qe_accounts', () => table.all()).orderBy('name'),
  }).named('sealedAccounts');

const serve = (target: AnyQuery) =>
  createServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => null },
  });

const wire = async (target: AnyQuery, search = ''): Promise<string> => {
  const response = await serve(target).fetch(
    new Request(`http://dev.test/_x/query/sealed-accounts${search}`, { method: 'GET' }),
  );
  expect(response.status).toBe(200);
  const headers = JSON.stringify([...response.headers.entries()]);
  return `${headers}\n${await response.text()}`;
};

const clean = (bytes: string): void => {
  // The row DID leave — an empty answer would pass every negative assertion below.
  expect(bytes).toContain('Ada');
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(LOOKUP_CANARY);
  expect(bytes).not.toMatch(SEALED);
  expect(bytes).not.toContain('credential');
  expect(bytes).not.toContain('contact');
};

describe('unit · a sealed column leaves through no projection of a query', () => {
  test('the loader holds the plaintext — the server reads it, so there is something to leak', async () => {
    const [row] = await table.all();
    expect(row?.credential).toBe(CANARY);
    expect(row?.contact).toBe(LOOKUP_CANARY);
  });

  test('GET /_x/query/<name>: the bare list', async () => {
    clean(await wire(list()));
  });

  test('GET with a page control: the Page envelope and its cursor', async () => {
    clean(await wire(list(), '?_first=1'));
  });

  test('GET of a single: true read: the one row', async () => {
    clean(await wire(list({ single: true })));
  });

  test('GET of a rows: read: `data` AND `records` of the record envelope', async () => {
    clean(await wire(list({ rows: true })));
    clean(await wire(list({ rows: true, single: true })));
  });

  test('the MCP read: what `tools/call` serialises', async () => {
    const rows = await toQueryTool(list()).read({}, { actor: null });
    clean(JSON.stringify(rows));
  });

  test('a live window: the rows a snapshot frame is built from', async () => {
    const live = await runWithContext(createContext({ actor: anonymousActor() }), () =>
      list().live({}),
    );
    const rows = await live.execute();
    clean(JSON.stringify({ rows, cursor: live.initialCursor(rows) }));
  });

  test('a live read may not filter or order on a sealed column: no change row carries one', async () => {
    const keyed = (
      build: (rows: ReturnType<typeof from<Account>>) => ReturnType<typeof from<Account>>,
    ) =>
      query({
        input: Input,
        policy: allow('public'),
        live: true,
        sql: () => build(from<Account>('qe_accounts', () => table.all())),
      }).named('sealedKeyed');
    const subscribe = async (target: AnyQuery): Promise<string> => {
      try {
        await runWithContext(createContext({ actor: anonymousActor() }), () => target.live({}));
      } catch (error) {
        return isUltimateError(error) ? `${error.code}: ${error.cause}` : 'uncoded';
      }
      return 'subscribed';
    };
    expect(await subscribe(keyed((rows) => rows.where({ contact: LOOKUP_CANARY })))).toMatch(
      /^X_MATCHER_UNSUPPORTED: .*sealed column "contact"/,
    );
    expect(await subscribe(keyed((rows) => rows.orderBy('credential')))).toMatch(
      /^X_MATCHER_UNSUPPORTED: .*sealed column "credential"/,
    );
    // The value itself is never rendered into the refusal.
    expect(await subscribe(keyed((rows) => rows.where({ contact: LOOKUP_CANARY })))).not.toContain(
      LOOKUP_CANARY,
    );
    expect(await subscribe(keyed((rows) => rows.where({ name: 'Ada' }).orderBy('name')))).toBe(
      'subscribed',
    );
    // An entity with no sealed column is not this rule's: any of its columns may key a window.
    const plain = query({
      input: Input,
      policy: allow('public'),
      live: true,
      sql: () => from<{ id: string; label: string }>('qe_labels', []).where({ label: 'x' }),
    }).named('plainLabels');
    expect(await subscribe(plain)).toBe('subscribed');
  });

  test('a cache: read: the entry a shared tier stores', async () => {
    const restoreTiers = isolateTiers();
    const stored: string[] = [];
    // `@ultimat3/cache`'s Redis tier writes `JSON.stringify(payload)` (`redis.ts`); this is that
    // write with nothing behind it.
    const tier: CacheTier = {
      name: 'redis',
      get: async () => undefined,
      set: async <T>(key: string, value: T, options?: CacheSetOptions) => {
        stored.push(JSON.stringify({ key, value, tags: options?.tags ?? [] }));
      },
      del: async () => {},
      invalidateTags: async () => ({ tier: 'redis', keys: [] }),
    };
    registerTier(tier);
    try {
      await list({ cached: true }).as(null, {});
    } finally {
      restoreTiers();
    }
    expect(stored).toHaveLength(1);
    clean(stored.join('\n'));
  });

  test('a derived row — a spread with a computed column beside it — carries none either', async () => {
    const derived = query({
      input: Input,
      policy: allow('public'),
      sql: () =>
        from('qe_accounts', async () =>
          (await table.all()).map((row) => ({ ...row, initials: row.name.slice(0, 1) })),
        ),
    }).named('sealedAccounts');
    clean(await wire(derived));
  });

  test('the server-side caller of the same read still reads the plaintext', async () => {
    const rows = (await list().as(null, {})) as readonly Account[];
    expect(rows[0]?.credential).toBe(CANARY);
    expect(rows[0]?.id).toBe(id);
  });
});
