// Single responsibility: the `replicator` role under `x dev` — the one place the Postgres logical
// replication feed is selected, locked and pumped into the transport. Everything it starts is what
// a `ROLE=replicator` container starts; the only difference is that this process also runs the
// roles reading the other end of that transport.

import { describeEntities } from '@ultimat3/entity';
import { ReplicatorSlotHeldError } from '@ultimat3/realtime';
import type { Replicator, Transport } from '@ultimat3/realtime/server';
import { createReplicator, replicatorLockKey, selectChangeFeed } from '@ultimat3/realtime/server';
import type { DevServices, Env } from './dev-services';
import { BadFlagError } from './errors';

export interface StartReplicatorOptions {
  readonly services: DevServices;
  readonly env: Env;
  readonly transport: Transport;
}

export interface RunningReplicator {
  readonly replicator: Replicator;
  /** The slot this process holds — the thing an operator greps for when two of these exist. */
  readonly slot: string;
  /** The env key that selected the feed, never the URL behind it: it carries a password. */
  readonly detail: string;
  stop(): Promise<void>;
}

/**
 * PGlite is a single-process WASM database with no walsender, so `--role replicator` against the
 * embedded default cannot ever work. Refused with the env var that makes it work rather than with
 * "not a dev role", which is what this used to say and sent an agent looking for a flag instead of
 * a database. Same code as before (`X_CLI_BAD_FLAG`) because it is the same invocation.
 */
const embeddedRefusal = (): BadFlagError =>
  new BadFlagError({
    flag: 'role',
    command: 'dev',
    reason:
      'the replicator decodes a write-ahead log, and the embedded database is PGlite — it has ' +
      'no walsender to decode',
    fix: 'DATABASE_URL=postgres://user:password@localhost:5432/app x dev --role replicator',
  });

/**
 * The relations the feed decodes: every registered entity's PHYSICAL TABLE, never its name.
 *
 * Both readers of this list are catalog readers. `PgReplicationStream` keeps a change only when
 * `#entities.has(relation.name)`, and a pgoutput Relation message names the table; `warnPartialIdentity`
 * matches the same list against `pg_class.relname`. An entity NAME is the framework's own registry
 * key — what a cache tag, a policy and `x entities describe` are keyed by — and `entity('user',
 * { table: 'users' })` makes the two different strings. Passing the name meant a renamed table
 * matched nothing on either side: every change SKIPPED, and a replica-identity warning that could
 * never fire. Latent wherever the two agree, which is every entity in `examples/dummy`.
 *
 * Deduplicated and sorted: two entities may share one table, and the same registry must hand the
 * feed the same list whatever order it was registered in.
 */
export function replicatedRelations(): readonly string[] {
  return [...new Set(describeEntities().map((entity) => entity.table))].sort();
}

/**
 * An entity list is the feed's filter, so an empty one is a replicator that decodes every change
 * and forwards none. Refused here rather than inside the feed: this is the layer that knows the
 * list came from the app's own registry, so it can name the command that adds to it.
 */
const noEntitiesRefusal = (): BadFlagError =>
  new BadFlagError({
    flag: 'role',
    command: 'dev',
    reason: 'no entities are registered, so the replicator would decode changes nothing matches',
    fix: 'x g entity Post title:text — then x dev --role replicator',
  });

/**
 * Lock first, feed second. A replicator that opened its slot before losing the lock race would
 * have already consumed WAL the holder is responsible for, and `pg_try_advisory_lock` is the only
 * thing standing between two containers and every change delivered twice.
 */
export async function startReplicator(options: StartReplicatorOptions): Promise<RunningReplicator> {
  if (options.services.db.mode === 'embedded') throw embeddedRefusal();
  const entities = replicatedRelations();
  if (entities.length === 0) throw noEntitiesRefusal();

  const selection = selectChangeFeed(options.env, { entities });
  const slot = selection.slot ?? '';
  const replicator = createReplicator({
    feed: selection.feed,
    transport: options.transport,
    lock: selection.lock,
  });
  // `start()` answers `false` for the one condition that is not this process's fault. A dev boot
  // has nothing to fail over to — the standby loop belongs to a container an orchestrator
  // restarts — so it is terminal here, with the code the topology docs already promised.
  if (!(await replicator.start())) {
    throw new ReplicatorSlotHeldError({ key: replicatorLockKey(slot) });
  }
  return {
    replicator,
    slot,
    detail: selection.detail,
    async stop() {
      await replicator.stop();
    },
  };
}
