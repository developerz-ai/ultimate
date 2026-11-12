// The declared optimistic lock on a real server: the same cases the memory driver runs
// (`version-lock-fixture.ts`), where two writers race on separate backends. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe } from 'bun:test';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { database } from './database';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { type LockedDb, lockedNotes, versionLockCases } from './version-lock-fixture';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;
const DROP = raw('drop table if exists version_lock_notes cascade');

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · version lock', () => {
  let client: PostgresClient;
  const db = (): LockedDb => database({ notes: lockedNotes }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string });
    setDbClient(client);
    await client.execute(DROP);
    const { up } = generateMigration({ entities: [lockedNotes.$describe()], name: 'version lock' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(DROP);
    setDbClient(undefined);
    await client.close();
  });

  versionLockCases(db, 1000);
});
