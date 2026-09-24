// A channel's `row` loader runs AS the subscribing actor. It ran under the node's own context —
// no actor, no tenant — so a repository read inside it was scoped by nothing but what the loader
// happened to name, and `verifyScope` could not hold the read to the subscriber's own tenant.

import { afterAll, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { QueryPolicy } from '@ultimat3/query';
import { authorizeChannel } from './channel-authz';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';

const O1 = '00000000-0000-4000-8000-0000000000a1';
const O2 = '00000000-0000-4000-8000-0000000000a2';

const notes = entity('authz_scoped_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 20 }) },
});
const db = database({ notes }, { driver: memoryDriver() });

afterAll(() => {
  clearChannels();
  clearRegistry();
});

/** Admits when the loaded row is non-empty; the test reads what the loader saw instead. */
const seen: string[][] = [];
const loadedAny: QueryPolicy = {
  kind: 'allow',
  label: 'notes:read',
  permissions: [],
  children: [],
  run: ({ row }) =>
    Array.isArray(row) && row.length > 0
      ? { allowed: true }
      : { allowed: false, reason: 'nothing', code: 'X_FORBIDDEN' },
};

const notesChannel = channel('authz-notes', {
  params: [],
  catchUp: { name: 'authzNotes' },
  policy: loadedAny,
  // Names NO tenant: the read is scoped by whoever it runs as, which is the point under test.
  row: async () => {
    const orgs = (await db.notes.all()).map((note) => note.orgId);
    seen.push(orgs);
    return orgs;
  },
});

describe('a channel row loader runs as the subscriber', () => {
  test('an unscoped repository read inside it returns only the subscriber’s tenant', async () => {
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000001', orgId: O1, label: 'a' });
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000002', orgId: O2, label: 'b' });
    const node = createContext({ role: 'sync', buildId: 'b' });

    await authorizeChannel(
      notesChannel,
      node,
      userActor({ id: 'alice', orgId: O1 }),
      'authz-notes',
      {},
    );

    expect(seen.at(-1)).toEqual([O1]);
  });
});
