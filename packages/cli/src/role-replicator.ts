// Single responsibility: the `replicator` role — the one place the Postgres logical replication
// feed is selected, locked and pumped into the transport, for `x dev --role replicator` and a
// `ROLE=replicator` container alike. The two differ in what losing the lock means: terminal under
// `x dev`, a standby that keeps asking in a container.

import {
  ConfigInvalidError,
  logger,
  registerReadinessCheck,
  renderThrowable,
} from '@ultimat3/core';
import { describeEntities } from '@ultimat3/entity';
import { ReplicatorSlotHeldError } from '@ultimat3/realtime';
import type { Replicator, ReplicatorOptions, Transport } from '@ultimat3/realtime/server';
import {
  changeFeedReplicator,
  replicatorLockKey,
  selectChangeFeed,
} from '@ultimat3/realtime/server';
import { BadFlagError } from './errors';
import type { DevServices, Env } from './runtime-bindings';

export interface StartReplicatorOptions {
  readonly services: DevServices;
  readonly env: Env;
  readonly transport: Transport;
  /**
   * `x dev` (true) or a container (false) — the boot's `WebBinding.dev`. It decides what a lost
   * lock race means and which invocation a refusal names: `x dev --role` is not a command a pod
   * can run, and `ROLE=` is not a flag `x dev` reads.
   */
  readonly dev: boolean;
  /** The replicator's constructor. A seam for the role's own tests; the boot never passes it. */
  readonly create?: (options: ReplicatorOptions) => Replicator;
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
const NO_WALSENDER =
  'the replicator decodes a write-ahead log, and the embedded database is PGlite — it has no ' +
  'walsender to decode';

const embeddedRefusal = (dev: boolean): BadFlagError | ConfigInvalidError =>
  dev
    ? new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: NO_WALSENDER,
        fix: 'DATABASE_URL=postgres://user:password@localhost:5432/app x dev --role replicator',
      })
    : new ConfigInvalidError({
        cause: `ROLE=replicator booted with no DATABASE_URL: ${NO_WALSENDER}`,
        fix: 'DATABASE_URL=postgres://user:password@host:5432/app ROLE=replicator bun apps/web/server.ts — in the chart, DATABASE_URL comes from the Secret named by existingSecret in docker/helm/values.yaml',
        meta: { key: 'DATABASE_URL', role: 'replicator' },
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
const NO_ENTITIES =
  'no entities are registered, so the replicator would decode changes nothing matches';

const noEntitiesRefusal = (dev: boolean): BadFlagError | ConfigInvalidError =>
  dev
    ? new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: NO_ENTITIES,
        fix: 'x g entity Post title:text — then x dev --role replicator',
      })
    : new ConfigInvalidError({
        cause: `ROLE=replicator: ${NO_ENTITIES}`,
        fix: 'x g entity Post title:text — then rebuild the image and roll the ROLE=replicator Deployment',
        meta: { role: 'replicator' },
      });

/** The name `/readyz` reports the replicator under. */
export const REPLICATOR_READINESS_CHECK = 'replicator';

/**
 * Ready means REPLICATING. A stream that ends is restarted by the replicator itself, and until it
 * is back `running` is `false`: this process holds no slot and publishes nothing, so it must not be
 * counted as the database's replicator. Returns the unregister.
 */
export function watchReplicatorReadiness(replicator: Pick<Replicator, 'running'>): () => void {
  return registerReadinessCheck(REPLICATOR_READINESS_CHECK, () => replicator.running);
}

/**
 * The standby: ask for the slot again on the replicator's own jittered backoff until it is granted
 * or the role is stopped. `start()` answering `false` arms no retry of its own — the replicator's
 * takeover loop covers a run it LOST, not one it never had — so a container that lost the race at
 * boot would otherwise stand by forever, and a holder that died would leave the slot unreplicated.
 *
 * Unref'd: a pending ask must never be what keeps a draining process alive. Returns the cancel.
 */
function standBy(replicator: Replicator, key: string): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = (attempt: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled) return;
      // Voided: both outcomes are handled here, and a timer has nobody to hand a promise to.
      void replicator.start().then(
        (held) => {
          if (held) logger.info('replicator.slot_taken_over', { key });
          else if (!cancelled) ask(attempt + 1);
        },
        (thrown: unknown) => {
          logger.warn('replicator.standby_failed', { key, error: renderThrowable(thrown) });
          if (!cancelled) ask(attempt + 1);
        },
      );
    }, replicator.retryDelayMs(attempt));
    timer.unref?.();
  };
  ask(0);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Lock first, feed second. A replicator that opened its slot before losing the lock race would
 * have already consumed WAL the holder is responsible for, and `pg_try_advisory_lock` is the only
 * thing standing between two containers and every change delivered twice.
 */
export async function startReplicator(options: StartReplicatorOptions): Promise<RunningReplicator> {
  if (options.services.db.mode === 'embedded') throw embeddedRefusal(options.dev);
  const entities = replicatedRelations();
  if (entities.length === 0) throw noEntitiesRefusal(options.dev);

  const selection = selectChangeFeed(options.env, { entities });
  const slot = selection.slot ?? '';
  const key = replicatorLockKey(slot);
  const replicator = (options.create ?? changeFeedReplicator)({
    feed: selection.feed,
    transport: options.transport,
    lock: selection.lock,
  });
  // `start()` answers `false` for the one condition that is not this process's fault: another
  // process holds the lock. A dev boot has nothing to fail over to, so it is terminal there, with
  // the code the topology docs promised. A container stays up, `/readyz` false, and stands by —
  // a pod that threw here crash-looped, and a rolling update waiting on its readiness never
  // terminated the old holder, so every rollout stalled (`replicator.ts`'s header: the loser stays
  // up, unready).
  let cancelStandby = (): void => undefined;
  if (!(await replicator.start())) {
    if (options.dev) throw new ReplicatorSlotHeldError({ key });
    logger.warn('replicator.standby', { key, detail: 'another process holds the slot' });
    cancelStandby = standBy(replicator, key);
  }
  const unregister = watchReplicatorReadiness(replicator);
  return {
    replicator,
    slot,
    detail: selection.detail,
    async stop() {
      // First: a replicator being stopped on purpose is not a failing one, and a standby must not
      // ask for a slot after the role that wanted it has gone.
      cancelStandby();
      unregister();
      await replicator.stop();
    },
  };
}
