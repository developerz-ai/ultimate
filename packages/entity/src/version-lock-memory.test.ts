// The declared optimistic lock on the memory driver — the cases `version-lock-fixture.ts` holds,
// which `version-lock.live.test.ts` runs unchanged against a real server.

import { afterAll, describe } from 'bun:test';
import { database, memoryDriver } from './database';
import { clearRegistry } from './registry';
import { type LockedDb, lockedNotes, versionLockCases } from './version-lock-fixture';

afterAll(() => {
  clearRegistry();
});

describe('unit · memory · version lock', () => {
  const db: LockedDb = database({ notes: lockedNotes }, { driver: memoryDriver() });
  versionLockCases(() => db, 0);
});
