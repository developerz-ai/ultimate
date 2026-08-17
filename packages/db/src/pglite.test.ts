import { describe, expect, test } from 'bun:test';
import { isReservable } from './client';
import { fakeDriver } from './fake-pglite';
import {
  createPgliteClient,
  loadPgliteDriver,
  PGLITE_FIX,
  PGLITE_MEMORY,
  type PgliteResult,
  pgliteDataDir,
} from './pglite';
import { sql } from './sql';
import { withTransaction } from './transaction';

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

/** A promise the test resolves by hand, so a race is driven by an event and not by the clock. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

  // The transaction's ALS store survives into any promise chain started inside its body, so a
  // statement the app forgot to `await` still read a live-looking store minutes after COMMIT — and
  // `run()` fenced on the store's PRESENCE, so it skipped the turn queue and landed inside whoever
  // held the single session next. Measured order before the fix: begin, inside tx, commit, begin,
  // straggler, inside tx 2, commit — a statement from a finished transaction committed by another.
  test('a straggler from a finished transaction waits its turn instead of joining the next one', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const gate = deferred();
    let straggler!: Promise<unknown>;

    await withTransaction(
      async () => {
        await client.query(sql`select 'inside tx'`);
        // The forgotten `await`: a chain started inside the body that outlives the scope. `.then`
        // inherits the store from here, which is exactly what made the dead transaction look live.
        straggler = gate.promise.then(() => client.query(sql`select 'straggler'`));
      },
      { client },
    );

    // Somebody else's unit of work takes the one session.
    const holder = await client.reserve();
    await holder.execute(sql`begin`);
    gate.resolve();
    // Not an ordering assertion: the straggler must never run here, so waiting longer only
    // strengthens it — the same shape as the released-reservation test above.
    await Bun.sleep(5);
    expect(driver.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      "select 'inside tx'",
      'COMMIT',
      'begin',
    ]);

    await holder.execute(sql`select 'inside tx 2'`);
    await holder.execute(sql`commit`);
    holder.release();
    await straggler;

    expect(driver.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      "select 'inside tx'",
      'COMMIT',
      'begin',
      "select 'inside tx 2'",
      'commit',
      "select 'straggler'",
    ]);
  });

  // A statement issued while the transaction is genuinely OPEN must still skip the queue: the
  // transaction is holding the turn, so waiting for one would hang forever. This is the shape
  // `handle.enqueue(input, { outbox: false })` inside `withTransaction` takes.
  test('a statement inside a LIVE transaction still runs on the turn that transaction holds', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });

    await withTransaction(
      async () => {
        await client.execute(sql`insert into outbox values (1)`);
      },
      { client },
    );

    expect(driver.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'insert into outbox values (1)',
      'COMMIT',
    ]);
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
