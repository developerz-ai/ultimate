// The handle follows the installed client: memory until `setDbClient` installs one, that client
// while it is, memory again once it is cleared — decided per call, through `database()`'s wrapping.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { recordingClient, setDbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { clearDriverStores, driverStores } from './driver-registry';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { testDriver } from './test-driver';

afterAll(() => {
  clearRegistry();
});

const notes = entity('test_driver_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 40 }) },
});

const MEMORY_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';

afterEach(() => setDbClient(undefined));

test('one handle writes to memory, then through the installed client, then to memory again', async () => {
  const driver = testDriver();
  const db = database({ notes }, { driver });

  await db.notes.insert({ id: MEMORY_ID, body: 'in memory' });
  expect((await db.notes.where({}).all()).map((row) => row.id)).toEqual([MEMORY_ID]);

  const client = recordingClient().on(/insert into/i, {
    rows: [{ id: CLIENT_ID, body: 'through the client' }],
  });
  setDbClient(client);
  const stored = await db.notes.insert({ id: CLIENT_ID, body: 'through the client' });
  expect(stored.id).toBe(CLIENT_ID);
  expect(client.texts.some((text) => /insert into "test_driver_notes"/i.test(text))).toBe(true);

  setDbClient(undefined);
  // The client's row never reached memory, and memory's row was there all along.
  expect((await db.notes.where({}).all()).map((row) => row.id)).toEqual([MEMORY_ID]);
});

test('reset empties memory only, and the transactor follows the same answer', async () => {
  const driver = testDriver();
  const db = database({ notes }, { driver });
  await db.notes.insert({ id: MEMORY_ID, body: 'in memory' });
  driver.reset?.();
  expect(await db.notes.where({}).count()).toBe(0);

  const client = recordingClient();
  setDbClient(client);
  const transactor = driver.transactor();
  await transactor.run(async () => 'done');
  expect(client.texts).toContain('BEGIN');

  setDbClient(undefined);
  const before = client.statements.length;
  await transactor.run(async () => 'done');
  expect(client.statements.length).toBe(before);
});

test('a repository resolved before the client was installed still follows it', async () => {
  const driver = testDriver();
  const repo = driver.repo(notes);
  const client = recordingClient();
  setDbClient(client);
  expect(await repo.count()).toBe(0);
  expect(client.texts.some((text) => /count/i.test(text))).toBe(true);
});

// A file that never installs a client pays nothing for the Postgres half: no PGlite is imported,
// so no WASM is compiled. A fresh process, because this one's neighbours may have loaded it.
test('a handle used without a client never imports PGlite', async () => {
  const script = `
    const { database, entity, testDriver, text, uuid } = await import('./src/index.ts');
    const notes = entity('probe_notes', { columns: { id: uuid().primaryKey(), body: text() } });
    const db = database({ notes }, { driver: testDriver() });
    await db.notes.insert({ id: '${MEMORY_ID}', body: 'memory' });
    await db.notes.where({}).count();
    console.log(JSON.stringify(Object.keys(require.cache).filter((k) => k.includes('@electric-sql'))));
  `;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: `${import.meta.dir}/..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? 'null')).toEqual([]);
});

// A transaction keeps the side it began on: a client installed or cleared inside one would split
// its writes across two stores, so the next repository call inside it is refused, by code.
test('a client installed inside a memory transaction is refused, not followed', async () => {
  const driver = testDriver();
  const db = database({ notes }, { driver });
  const client = recordingClient();
  const outcome = driver.transactor().run(async (tx) => {
    setDbClient(client);
    await db.notes.insert({ id: MEMORY_ID, body: 'split' }, { tx });
  });
  await expect(outcome).rejects.toMatchObject({ code: 'X_TEST_DRIVER_CLIENT_CHANGED' });
  expect(client.texts.some((text) => /insert/i.test(text))).toBe(false);
});

test('a client cleared inside a Postgres transaction is refused, not followed', async () => {
  const driver = testDriver();
  const db = database({ notes }, { driver });
  setDbClient(recordingClient());
  const outcome = driver.transactor().run(async (tx) => {
    setDbClient(undefined);
    await db.notes.insert({ id: MEMORY_ID, body: 'split' }, { tx });
  });
  await expect(outcome).rejects.toMatchObject({ code: 'X_TEST_DRIVER_CLIENT_CHANGED' });
  setDbClient(undefined);
  expect(await db.notes.where({}).count()).toBe(0);
});

test('the refusal is a rejection, never a synchronous throw', async () => {
  const driver = testDriver();
  const repo = driver.repo(notes);
  let thrown: unknown;
  let pending: Promise<unknown> | undefined;
  await driver.transactor().run(async () => {
    setDbClient(recordingClient());
    try {
      pending = repo.count();
    } catch (error) {
      thrown = error;
    }
  });
  expect(thrown).toBeUndefined();
  await expect(pending).rejects.toMatchObject({ code: 'X_TEST_DRIVER_CLIENT_CHANGED' });
});

// `x verify`'s drift step skips only when no SQL store was ever built; a Postgres app (and every
// test driver, which builds one) must say so as it is constructed (`driver-registry.ts`).
test('building the test driver notes a Postgres store', () => {
  clearDriverStores();
  testDriver();
  expect(driverStores().sql).toEqual(['postgres']);
  clearDriverStores();
});
