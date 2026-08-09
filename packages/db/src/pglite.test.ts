import { describe, expect, test } from 'bun:test';
import {
  createPgliteClient,
  loadPgliteDriver,
  PGLITE_FIX,
  PGLITE_MEMORY,
  type PgliteDriver,
  type PgliteResult,
  pgliteDataDir,
} from './pglite';
import { sql } from './sql';

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

function fakeDriver(result: PgliteResult): PgliteDriver & {
  readonly calls: Recorded[];
  closed: number;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    closed: 0,
    async query(text, values) {
      calls.push({ text, values: values ?? [] });
      return result;
    },
    async close() {
      this.closed += 1;
    },
  };
}

/** A stand-in for the `@electric-sql/pglite` namespace: same one export, no WASM. */
const fakeModule = (
  onConstruct: (dataDir: string | undefined) => void,
  result: PgliteResult = { rows: [] },
): unknown => ({
  PGlite: class {
    constructor(dataDir?: string) {
      onConstruct(dataDir);
    }
    async query(): Promise<PgliteResult> {
      return result;
    }
    async close(): Promise<void> {}
  },
});

const failure = async (run: () => Promise<unknown>): Promise<{ code: string; fix: string }> => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; fix: string };
  }
  throw new Error('expected the call to reject');
};

describe('pgliteDataDir', () => {
  test('a pglite:// url unwraps to the directory it points at', () => {
    expect(pgliteDataDir('pglite:///home/a/.x/pgdata')).toBe('/home/a/.x/pgdata');
  });

  test('every in-memory spelling collapses to one dataDir', () => {
    expect(pgliteDataDir('pglite://memory/ultimate_test_w0')).toBe(PGLITE_MEMORY);
    expect(pgliteDataDir('pglite://memory')).toBe(PGLITE_MEMORY);
    expect(pgliteDataDir('pglite://')).toBe(PGLITE_MEMORY);
  });

  test('a plain path is already a dataDir and passes through untouched', () => {
    expect(pgliteDataDir('.x/pgdata')).toBe('.x/pgdata');
    expect(pgliteDataDir(PGLITE_MEMORY)).toBe(PGLITE_MEMORY);
  });
});

describe('loadPgliteDriver', () => {
  test('constructs PGlite with the dataDir, defaulting to memory', async () => {
    const seen: (string | undefined)[] = [];
    await loadPgliteDriver({ load: async () => fakeModule((dir) => seen.push(dir)) });
    await loadPgliteDriver({
      dataDir: '/tmp/pgdata',
      load: async () => fakeModule((dir) => seen.push(dir)),
    });
    expect(seen).toEqual([PGLITE_MEMORY, '/tmp/pgdata']);
  });

  test('an injected driver short-circuits the loader entirely', async () => {
    const driver = fakeDriver({ rows: [] });
    let loaded = false;
    const resolved = await loadPgliteDriver({
      driver,
      load: async () => {
        loaded = true;
        return fakeModule(() => undefined);
      },
    });
    expect(resolved).toBe(driver);
    expect(loaded).toBe(false);
  });

  test('a missing package fails with X_DB_UNAVAILABLE carrying the install command', async () => {
    const error = await failure(() =>
      loadPgliteDriver({
        load: () => Promise.reject(new Error('Cannot find module')),
      }),
    );
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect(error.fix).toBe(PGLITE_FIX);
  });

  test('a module without a PGlite constructor is rejected, not trusted', async () => {
    const error = await failure(() => loadPgliteDriver({ load: async () => ({ Pg: 1 }) }));
    expect(error.code).toBe('X_DB_UNAVAILABLE');
  });

  test('a constructor that throws is reported against the dataDir it was given', async () => {
    const error = await failure(() =>
      loadPgliteDriver({
        dataDir: '/nope',
        load: async () => ({
          PGlite: class {
            constructor() {
              throw new Error('EACCES');
            }
          },
        }),
      }),
    );
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect((error as unknown as { cause: string }).cause).toContain('/nope');
  });
});

describe('createPgliteClient', () => {
  test('execute reports the command tag, not the empty row set', async () => {
    const driver = fakeDriver({ rows: [], affectedRows: 3 });
    const client = createPgliteClient({ driver });
    expect(await client.execute(sql`delete from posts`)).toBe(3);
  });

  test('execute falls back to row count when the driver reports no command tag', async () => {
    const driver = fakeDriver({ rows: [{ id: 1 }, { id: 2 }] });
    expect(await createPgliteClient({ driver }).execute(sql`select 1`)).toBe(2);
  });

  test('query and one read rows, and bind values as parameters', async () => {
    const driver = fakeDriver({ rows: [{ id: 7 }] });
    const client = createPgliteClient({ driver });
    expect(await client.query(sql`select id from posts where id = ${7}`)).toEqual([{ id: 7 }]);
    expect(await client.one<{ id: number }>(sql`select id from posts`)).toEqual({ id: 7 });
    expect(driver.calls[0]).toEqual({ text: 'select id from posts where id = $1', values: [7] });
  });

  test('one answers null on an empty result rather than undefined', async () => {
    expect(await createPgliteClient({ driver: fakeDriver({ rows: [] }) }).one(sql`select 1`)).toBe(
      null,
    );
  });

  test('a statement failure surfaces as X_DB_UNAVAILABLE with the statement in the cause', async () => {
    const client = createPgliteClient({
      driver: {
        query: () => Promise.reject(new Error('syntax error')),
        close: async () => undefined,
      },
    });
    const error = await failure(() => client.query(sql`selct 1`));
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect((error as unknown as { cause: string }).cause).toContain('selct 1');
  });

  test('concurrent first queries share one boot — PGlite is too slow to build twice', async () => {
    let constructed = 0;
    const client = createPgliteClient({
      load: async () => fakeModule(() => (constructed += 1), { rows: [{ ok: 1 }] }),
    });
    await Promise.all([client.query(sql`select 1`), client.query(sql`select 2`), client.ping()]);
    expect(constructed).toBe(1);
  });

  test('a failed boot is not cached, so the retry after `bun add` succeeds', async () => {
    let attempts = 0;
    const client = createPgliteClient({
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Cannot find module');
        return fakeModule(() => undefined, { rows: [{ ok: 1 }] });
      },
    });
    expect((await failure(() => client.ping())).code).toBe('X_DB_UNAVAILABLE');
    await client.ping();
    expect(attempts).toBe(2);
  });

  test('close shuts the driver down once and is a no-op before the first query', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    await client.close();
    expect(driver.closed).toBe(0);

    const booted = createPgliteClient({ driver });
    await booted.query(sql`select 1`);
    await booted.close();
    await booted.close();
    expect(driver.closed).toBe(1);
  });

  test('close never rethrows a boot that failed', async () => {
    const client = createPgliteClient({ load: () => Promise.reject(new Error('nope')) });
    void client.ping().catch(() => undefined);
    expect(await client.close().then(() => 'closed')).toBe('closed');
  });
});

// The fakes above pin the adapter; this pins the binding. Without it "the driver is wired up" is
// a claim about a module specifier nobody ever resolved — which is what the stub used to be.
describe('the real embedded database', () => {
  // A WASM compile plus an initdb — ~1.5s on a CI runner, against bun's 5s default. Stated so a
  // slow machine reads as slow rather than as a broken driver; it is a hang detector, not a budget.
  const PGLITE_BOOT_MS = 30_000;

  test(
    'boots from the default loader and runs Postgres, with no server and no Docker',
    async () => {
      const client = createPgliteClient();
      try {
        await client.execute(sql`create table posts (id int primary key, title text)`);
        expect(await client.execute(sql`insert into posts values (${1}, ${'hello'})`)).toBe(1);
        expect(await client.execute(sql`insert into posts values (${2}, ${'world'})`)).toBe(1);
        expect(
          await client.one<{ title: string }>(sql`select title from posts where id = ${2}`),
        ).toEqual({ title: 'world' });
        expect(await client.query(sql`select id from posts order by id`)).toEqual([
          { id: 1 },
          { id: 2 },
        ]);
        expect(await client.execute(sql`delete from posts`)).toBe(2);
      } finally {
        await client.close();
      }
    },
    PGLITE_BOOT_MS,
  );
});
