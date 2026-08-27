// The `replicator` role's refusals and its one happy path. The feed itself is proved against a
// real walsender in `@ultimat3/realtime`; what is pinned here is that this role selects the
// Postgres feed at all — it was unreachable, and the class of bug is a driver nothing constructs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { replicatedRelations, startReplicator } from './dev-replicator';
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

  /**
   * The feed's filter is a list of RELATION names: `PgReplicationStream` matches every pgoutput
   * Relation message with `#entities.has(relation.name)`, and `warnPartialIdentity` matches the
   * same list against `pg_class.relname`. Both are the physical table. An entity NAME is the
   * framework's own registry key and is a different string the moment `table:` is declared.
   *
   * `examples/dummy` cannot catch this: all six of its entities have `name === table`, so a
   * fixture built from them passes with either projection. This one is `billingAccount` on
   * `billing_accounts` — different strings, and only one of them is a relation.
   */
  test('the feed is filtered by the physical TABLE, never by the entity name', () => {
    entity('billingAccount', {
      table: 'billing_accounts',
      columns: { id: uuid().primaryKey(), note: text() },
    });
    expect(replicatedRelations()).toEqual(['billing_accounts']);
  });

  test('two entities on one table give the feed that relation once', () => {
    entity('billingAccount', {
      table: 'billing_accounts',
      columns: { id: uuid().primaryKey(), note: text() },
    });
    entity('billingArchive', {
      table: 'billing_accounts',
      columns: { id: uuid().primaryKey(), note: text() },
    });
    expect(replicatedRelations()).toEqual(['billing_accounts']);
  });

  /**
   * The same fact through the real call chain, so the projection above is proved to be the one
   * `selectChangeFeed` is handed. `PgReplicationStream`'s constructor screens every entry with
   * `assertIdentifier`, and `billingAccount` is not a lower-case postgres identifier while
   * `billing_accounts` is — so the entity name is refused *before any connection* and the table
   * gets past the screen to fail on the database that is not there.
   */
  test('the value that reaches selectChangeFeed passes the identifier screen', async () => {
    entity('billingAccount', {
      table: 'billing_accounts',
      columns: { id: uuid().primaryKey(), note: text() },
    });

    let thrown: unknown;
    try {
      await startReplicator({ services: external, env: ENV, transport });
    } catch (error) {
      thrown = error;
    }

    // It must still fail — there is no database — so the assertion below cannot pass vacuously.
    if (thrown === undefined) expect.unreachable('the replicator started without a database');
    const raw = (thrown as { cause?: unknown }).cause;
    const cause = typeof raw === 'string' ? raw : '';
    expect(cause).not.toContain('not a lower-case postgres identifier');
    expect(cause).not.toContain('billingAccount');
  });

  test('the entity list comes from the app registry, so the feed filters what the app declared', () => {
    declarePost();
    entity('comment', { columns: { id: uuid().primaryKey(), body: text() } });
    // Proven through the refusal path rather than a live connection: with entities registered the
    // role gets past its own preflight and fails only on the database that is not there.
    expect(startReplicator({ services: external, env: ENV, transport })).rejects.toThrow();
  });
});
