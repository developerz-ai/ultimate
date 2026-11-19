// The memory authorization-server store's purge of clients: the same case the Postgres store runs
// in `authorization-server-postgres.test.ts`, so the two cannot answer differently.

import { describe, test } from 'bun:test';
import { dynamicClientPurgeCase } from './authorization-server-purge-fixture';
import { memoryAuthServerStore } from './authorization-server-store';

describe('memoryAuthServerStore purge', () => {
  test('purge removes a dynamic client that never got a grant, and no other client', async () => {
    await dynamicClientPurgeCase(memoryAuthServerStore());
  });
});
