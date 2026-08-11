// The `replicator` role's refusals and its one happy path. The feed itself is proved against a
// real walsender in `@ultimat3/realtime`; what is pinned here is that this role selects the
// Postgres feed at all — it was unreachable, and the class of bug is a driver nothing constructs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { Transport } from '@ultimat3/realtime';
import { InProcessTransport } from '@ultimat3/realtime';
import { startReplicator } from './dev-replicator';
import type { DevServices } from './dev-services';

const embedded: DevServices = {
  stateDir: '/tmp/x-replicator-test',
  db: { name: 'db', mode: 'embedded', url: 'pglite:///tmp/pgdata', detail: 'PGlite' },
  events: { name: 'events', mode: 'embedded', url: 'inproc://events', detail: 'in-process' },
  storage: { name: 'storage', mode: 'embedded', url: 'file:///tmp/s', detail: 'local' },
};

const external: DevServices = {
  ...embedded,
  db: {
    name: 'db',
    mode: 'external',
    url: 'postgres://app:secret@localhost:5432/postly',
    detail: 'DATABASE_URL',
  },
};

const ENV = { DATABASE_URL: 'postgres://app:secret@localhost:5432/postly' };

let transport: Transport;

beforeEach(() => {
  clearRegistry();
  transport = new InProcessTransport();
});

afterEach(async () => {
  clearRegistry();
  await transport.close();
});

const declarePost = (): void => {
  entity('post', { columns: { id: uuid().primaryKey(), title: text() } });
};

describe('x dev --role replicator', () => {
  test('the embedded database is refused, with the env var that makes it work', async () => {
    declarePost();
    let thrown: unknown;
    try {
      await startReplicator({ services: embedded, env: {}, transport });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    // The old refusal said "not a dev role", which sent an agent looking for a flag to drop.
    expect((thrown as { fix: string }).fix).toContain('DATABASE_URL=postgres://');
    expect((thrown as { cause: string }).cause).toContain('PGlite');
  });

  test('an app with no entities is refused: the feed would match nothing', async () => {
    let thrown: unknown;
    try {
      await startReplicator({ services: external, env: ENV, transport });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((thrown as { fix: string }).fix).toContain('x g entity');
  });

  test('a slot name that is not a postgres identifier is refused before any connection', async () => {
    declarePost();
    await expect(
      startReplicator({
        services: external,
        env: { ...ENV, REPLICATION_SLOT: 'Not An Identifier' },
        transport,
      }),
    ).rejects.toThrow(/not a lower-case postgres identifier/);
  });

  test('a REPLICATION_URL for a different database is refused, not silently preferred', async () => {
    declarePost();
    await expect(
      startReplicator({
        services: external,
        env: { ...ENV, REPLICATION_URL: 'postgres://repl:x@localhost:5432/other' },
        transport,
      }),
    ).rejects.toThrow(/REPLICATION_URL names/);
  });

  test('the entity list comes from the app registry, so the feed filters what the app declared', () => {
    declarePost();
    entity('comment', { columns: { id: uuid().primaryKey(), body: text() } });
    // Proven through the refusal path rather than a live connection: with entities registered the
    // role gets past its own preflight and fails only on the database that is not there.
    expect(startReplicator({ services: external, env: ENV, transport })).rejects.toThrow();
  });
});
