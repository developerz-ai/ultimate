import { afterEach, describe, expect, test } from 'bun:test';
import { isReservable, setDbClient } from './client';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver } from './observe';
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
import { withTransaction } from './transaction';

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

  // PGlite counts MODIFIED rows, so it tags a SELECT `affectedRows: 0` — a count of 0 is "this
  // statement counted nothing", never "this statement touched nothing", and reading it as the
  // latter made execute answer 0 for every read while `PostgresClient.execute` answered 2.
  test('execute counts the rows of a SELECT the driver tagged with affectedRows: 0', async () => {
    const read = fakeDriver({ rows: [{ id: 1 }, { id: 2 }], affectedRows: 0 });
    expect(await createPgliteClient({ driver: read }).execute(sql`select id from posts`)).toBe(2);

    const written = fakeDriver({ rows: [], affectedRows: 3 });
    expect(await createPgliteClient({ driver: written }).execute(sql`delete from posts`)).toBe(3);
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

  test('is reservable, so withTransaction pins it instead of sharing it', () => {
    expect(isReservable(createPgliteClient({ driver: fakeDriver({ rows: [] }) }))).toBe(true);
  });

  test('a reservation holds the one connection until it is released', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const reserved = await client.reserve();

    await reserved.execute(sql`begin`);
    const queued = client.execute(sql`insert into t values (1)`);
    await Bun.sleep(5);
    expect(driver.calls.map((call) => call.text)).toEqual(['begin']);

    await reserved.execute(sql`commit`);
    reserved.release();
    await queued;
    expect(driver.calls.map((call) => call.text)).toEqual([
      'begin',
      'commit',
      'insert into t values (1)',
    ]);
  });

  // `withTransaction` releases in a `finally`, so a caller that kept its `tx` past the callback
  // holds a handle with no claim on the connection. Writing straight to the shared driver then
  // lands the statement inside whoever holds the turn now — a stray row in someone else's
  // transaction, committed or rolled back with it, and no error anywhere to explain it.
  test('a released reservation waits its turn rather than writing over the holder', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const leaked = await client.reserve();
    leaked.release();

    const holder = await client.reserve();
    await holder.execute(sql`begin`);
    const late = leaked.execute(sql`insert into t values (1)`);
    await Bun.sleep(5);
    expect(driver.calls.map((call) => call.text)).toEqual(['begin']);

    holder.release();
    await late;
    expect(driver.calls.map((call) => call.text)).toEqual(['begin', 'insert into t values (1)']);
  });

  // The single session makes this the loudest failure in the framework: a reservation that is
  // never released keeps the turn forever, and the next statement — any statement, from any
  // request — waits for a turn that is never coming. `using` is what makes forgetting impossible.
  test('`using` gives the turn back, so the next statement is not wedged behind it', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });

    {
      using reserved = await client.reserve();
      await reserved.execute(sql`begin`);
      await reserved.execute(sql`commit`);
    }

    await client.execute(sql`insert into t values (1)`);
    expect(driver.calls.map((call) => call.text)).toEqual([
      'begin',
      'commit',
      'insert into t values (1)',
    ]);
  });

  // The RAII rewrite moved BEGIN inside the guarded scope precisely so a rejecting first statement
  // still gives the turn back — before that fix the turn stayed with a reservation nobody could
  // reach, and every later statement in the process queued behind it forever.
  test('a failed BEGIN does not wedge the queue — a second statement still runs', async () => {
    const driver: PgliteDriver = {
      async query(text) {
        if (text === 'begin') throw new Error('connection reset');
        return { rows: [] };
      },
      async close() {},
    };
    const client = createPgliteClient({ driver });

    const failed = (async () => {
      using reserved = await client.reserve();
      await reserved.execute(sql`begin`);
    })();
    await expect(failed).rejects.toThrow();

    // Bounded by the test's own timeout: a wedged queue hangs here rather than failing loud.
    await expect(client.execute(sql`insert into t values (1)`)).resolves.toBeDefined();
  });

  test('releasing after disposal is a no-op, not a second turn', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const reserved = await client.reserve();

    reserved[Symbol.dispose]();
    reserved.release();

    // A second turn handed out would let this statement start while the holder below still owns
    // the connection; taking a fresh reservation proves the queue has exactly one turn in it.
    const holder = await client.reserve();
    const queued = client.execute(sql`insert into t values (1)`);
    await Bun.sleep(5);
    expect(driver.calls).toEqual([]);

    holder.release();
    await queued;
    expect(driver.calls.map((call) => call.text)).toEqual(['insert into t values (1)']);
  });
});

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

describe('the statement observer', () => {
  afterEach(() => {
    // Both are process-wide: leaving either installed makes every later test observe this one's.
    setStatementObserver(undefined);
    setDbClient(undefined);
  });

  // `statement()` is the funnel: the queued path, the pinned path and the in-transaction path that
  // skips the queue all land on it. A detector fed by only one of the three would be blind to
  // exactly the reads that happen inside a transaction.
  test('sees every statement once, whichever of the three paths it took', async () => {
    const driver = fakeDriver({ rows: [{ id: 1 }, { id: 2 }], affectedRows: 0 });
    const client = createPgliteClient({ driver });
    setDbClient(client);
    const observer = recorder();
    setStatementObserver(observer);

    await client.query(sql`select id from posts where org = ${'o_1'}`);
    await withTransaction(async (tx) => {
      await tx.execute(sql`insert into posts values (${1})`);
      // Through the ambient client, so it reaches `run()` with a transaction open and skips the
      // queue rather than waiting for a turn the transaction is already holding.
      await client.query(sql`select id from posts`);
    });

    expect(observer.seen.map((event) => event.text)).toEqual([
      'select id from posts where org = $1',
      'BEGIN',
      'insert into posts values ($1)',
      'select id from posts',
      'COMMIT',
    ]);
    expect(observer.seen[0]?.values).toEqual(['o_1']);
    expect(observer.seen[0]?.rows).toBe(2);
    expect(observer.seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(observer.seen[0]).not.toHaveProperty('error');
  });

  // The same count `execute()` answers with, from the same helper — a report saying 0 rows for
  // every write while `execute` said 3 would make the two disagree about the same statement.
  test('counts rows the way execute does: the command tag for a write', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [], affectedRows: 3 }) });
    const observer = recorder();
    setStatementObserver(observer);

    expect(await client.execute(sql`delete from posts`)).toBe(3);
    expect(observer.seen[0]?.rows).toBe(3);
  });

  test('reports a failed statement with the error the caller is about to be thrown', async () => {
    const client = createPgliteClient({
      driver: {
        query: () => Promise.reject(new Error('syntax error')),
        close: async () => undefined,
      },
    });
    const observer = recorder();
    setStatementObserver(observer);

    const error = await failure(() => client.query(sql`selct 1`));

    expect(error.code).toBe('X_DB_UNAVAILABLE');
    // Identity, not shape: the event carries the very error thrown, already wrapped by the funnel.
    expect(observer.seen[0]?.error).toBe(error);
    expect(observer.seen[0]?.rows).toBe(0);
  });

  // Strict test mode is an observer that throws, and the throw must arrive as itself. Notifying
  // inside the statement's own `try` would report a statement that succeeded as X_DB_UNAVAILABLE.
  test('a throwing observer reaches the caller as its own error, not a database failure', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [] }) });
    setStatementObserver({
      onStatement(): void {
        throw new Error('n+1 in a strict test');
      },
    });

    await expect(client.query(sql`select 1`)).rejects.toThrow('n+1 in a strict test');
  });

  test('booting, reserving and closing are not statements', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const observer = recorder();
    setStatementObserver(observer);

    await client.ping();
    (await client.reserve()).release();
    await client.close();

    expect(observer.seen).toEqual([]);
  });

  test('an uninstalled seam observes nothing, which is the production path', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    setStatementObserver(undefined);

    await createPgliteClient({ driver: fakeDriver({ rows: [] }) }).query(sql`select 1`);

    expect(observer.seen).toEqual([]);
  });
});
