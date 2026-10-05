// The `replicator` role's refusals and its one happy path. The feed itself is proved against a
// real walsender in `@ultimat3/realtime`; what is pinned here is that this role selects the
// Postgres feed at all — it was unreachable, and the class of bug is a driver nothing constructs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readinessChecks } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { Replicator, ReplicatorStats, Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import {
  REPLICATOR_READINESS_CHECK,
  replicatedRelations,
  startReplicator,
  watchReplicatorReadiness,
} from './role-replicator';
import type { DevServices } from './runtime-bindings';

const embedded: DevServices = {
  root: '/tmp',
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
      await startReplicator({ services: embedded, env: {}, transport, dev: true });
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
      await startReplicator({ services: external, env: ENV, transport, dev: true });
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
        dev: true,
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
        dev: true,
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
      await startReplicator({ services: external, env: ENV, transport, dev: true });
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

  test('the entity list comes from the app registry, so the feed filters what the app declared', async () => {
    declarePost();
    entity('comment', { columns: { id: uuid().primaryKey(), body: text() } });
    // Proven through the refusal path rather than a live connection: with entities registered the
    // role gets past its own preflight and fails only on the database that is not there.
    await expect(
      startReplicator({ services: external, env: ENV, transport, dev: true }),
    ).rejects.toThrow();
  });
});

// A replication stream that ends is restarted by the replicator itself, and for as long as that
// takes this process replicates nothing. `/readyz` used to read only the transport, so a pod whose
// stream was dead stayed in rotation as the database's one replicator.
describe('the replicator readiness check', () => {
  test('follows `running`: failing while the stream is down, ok once it is back', () => {
    const replicator = { running: true };
    const unregister = watchReplicatorReadiness(replicator);
    try {
      expect(readinessChecks()[REPLICATOR_READINESS_CHECK]).toBe('ok');
      // The stream ended on its own; the takeover loop has not brought it back yet.
      replicator.running = false;
      expect(readinessChecks()[REPLICATOR_READINESS_CHECK]).toBe('failing');
      replicator.running = true;
      expect(readinessChecks()[REPLICATOR_READINESS_CHECK]).toBe('ok');
    } finally {
      unregister();
    }
    // Unregistered with the role: a stopped replicator must not hold a pod's readiness red.
    expect(Object.hasOwn(readinessChecks(), REPLICATOR_READINESS_CHECK)).toBe(false);
  });
});

/**
 * A replicator that answers `start()` from a script: `false` is "another process holds the lock",
 * which is the one outcome the role decides about. The feed and the lock behind a real one are
 * proved in `@ultimat3/realtime`; what is pinned here is what the ROLE does with the answer.
 */
const scripted = (answers: readonly boolean[]) => {
  let calls = 0;
  let stops = 0;
  let pumping = false;
  const stats: ReplicatorStats = {
    published: 0,
    skipped: 0,
    outOfOrder: 0,
    restarts: 0,
    failure: null,
  };
  const replicator: Replicator = {
    start: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)] ?? false;
      calls += 1;
      pumping = answer;
      return answer;
    },
    stop: async () => {
      stops += 1;
      pumping = false;
    },
    get running() {
      return pumping;
    },
    lastLsn: () => null,
    stats: () => stats,
    // The real one is jittered and seconds long; the loop's shape is what is under test.
    retryDelayMs: () => 1,
  };
  return {
    replicator,
    create: () => replicator,
    calls: () => calls,
    stops: () => stops,
  };
};

const until = async (condition: () => boolean, label: string): Promise<void> => {
  for (let tick = 0; tick < 200; tick += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  expect.unreachable(`timed out waiting for ${label}`);
};

describe('losing the advisory lock', () => {
  test('an x dev boot that loses the lock refuses with X_REPLICATOR_SLOT_HELD', async () => {
    declarePost();
    const fake = scripted([false]);
    let thrown: unknown;
    try {
      await startReplicator({
        services: external,
        env: ENV,
        transport,
        dev: true,
        create: fake.create,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_REPLICATOR_SLOT_HELD');
  });

  /**
   * A container that threw here crash-looped, and under the chart's rolling update the old holder
   * is never terminated while the new pod is unready — so every helm rollout stalled. The loser
   * stays up, `/readyz` false, and keeps asking for the slot until the holder lets go.
   */
  test('a container boot that loses the lock stays up and unready', async () => {
    declarePost();
    const fake = scripted([false, false, true]);
    const running = await startReplicator({
      services: external,
      env: ENV,
      transport,
      dev: false,
      create: fake.create,
    });
    try {
      expect(readinessChecks()[REPLICATOR_READINESS_CHECK]).toBe('failing');
      await until(() => fake.calls() >= 3, 'the standby to ask again');
      expect(readinessChecks()[REPLICATOR_READINESS_CHECK]).toBe('ok');
    } finally {
      await running.stop();
    }
    expect(fake.stops()).toBe(1);
    expect(Object.hasOwn(readinessChecks(), REPLICATOR_READINESS_CHECK)).toBe(false);
  });

  test('a stopped standby asks for the slot no more', async () => {
    declarePost();
    const fake = scripted([false]);
    const running = await startReplicator({
      services: external,
      env: ENV,
      transport,
      dev: false,
      create: fake.create,
    });
    await until(() => fake.calls() >= 2, 'the standby to ask again');
    await running.stop();
    const asked = fake.calls();
    await Bun.sleep(10);
    expect(fake.calls()).toBe(asked);
  });

  test('container refusal names ROLE, not x dev', async () => {
    declarePost();
    let thrown: unknown;
    try {
      await startReplicator({ services: embedded, env: {}, transport, dev: false });
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) expect.unreachable('the embedded database was not refused');
    const said = `${(thrown as { cause: string }).cause} ${(thrown as { fix: string }).fix}`;
    expect(said).toContain('ROLE=replicator');
    expect(said).toContain('DATABASE_URL');
    // Pasted from its first character (`bun run scripts/fix-prose.ts`): the env, then the command.
    expect((thrown as { fix: string }).fix).toMatch(/^DATABASE_URL=\S+ ROLE=replicator bun /);
    expect(said).not.toContain('x dev');
    expect(said).not.toContain('--role');
  });

  test('a container with no entities is refused without naming x dev', async () => {
    let thrown: unknown;
    try {
      await startReplicator({ services: external, env: ENV, transport, dev: false });
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) expect.unreachable('an empty entity list was not refused');
    const said = `${(thrown as { cause: string }).cause} ${(thrown as { fix: string }).fix}`;
    expect(said).toContain('x g entity');
    expect(said).not.toContain('x dev');
    expect(said).not.toContain('--role');
  });
});
