// Single responsibility: `defineDriver` — a custom store (Mongo, Cassandra, key-value) as a `Driver`.
// The store sees only scoped plans and judged rows; this assembles the read and write halves, the
// locks and both outer seams (`sealedRepo`, then `appendOnlyRepo`), so nothing a store forgets
// becomes a leak. Capabilities are declared here and checked when a table opens.

import { refuseAbandoned } from '@ultimat3/db';
import { appendOnlyRepo } from './append-only';
import type { Driver } from './database';
import { driverCapabilityMissing, driverUnsupported } from './driver-errors';
import type { DriverCapability, DriverDefinition, DriverRepo } from './driver-kit-types';
import { noteDriverStore } from './driver-registry';
import { driverReads } from './driver-repo-reads';
import { driverWrites } from './driver-repo-writes';
import { driverScope } from './driver-scope';
import type { RawFor } from './driver-write-scope';
import type { EntityCore } from './entity';
import { notFound } from './errors';
import { lockKeyInput } from './lock-key';
import { idPlan } from './plan';
import type { Repo, RepoOptions, Tx } from './repo';
import { sealedRepo } from './sealed-repo';
import type { IdOf } from './types';

export type {
  DriverAdvance,
  DriverCapability,
  DriverDefinition,
  DriverFilter,
  DriverRead,
  DriverRepo,
  DriverWrite,
} from './driver-kit-types';

/** The raw-repo member each capability needs; `transactions` is the definition's `transactor`. */
const MEMBER: Readonly<Record<DriverCapability, keyof DriverRepo<unknown> | 'transactor'>> = {
  transactions: 'transactor',
  lock: 'lock',
  series: 'series',
  upsert: 'upsert',
  matches: 'select',
  'aggregate:countBy': 'countBy',
  'aggregate:sum': 'aggregate',
  'aggregate:avg': 'aggregate',
  'aggregate:min': 'aggregate',
  'aggregate:max': 'aggregate',
  'aggregate:approximateCount': 'approximateCount',
};

const assertImplemented = (definition: DriverDefinition, raw: DriverRepo<unknown>): void => {
  for (const capability of definition.capabilities) {
    // Own keys only: a JS caller's `capabilities: ['toString']` must not read the prototype.
    const member = Object.hasOwn(MEMBER, capability) ? MEMBER[capability] : undefined;
    if (member === undefined) {
      throw driverCapabilityMissing(definition.name, String(capability), 'a known capability');
    }
    const present =
      member === 'transactor'
        ? typeof definition.transactor === 'function'
        : typeof raw[member] === 'function';
    if (!present) throw driverCapabilityMissing(definition.name, capability, member);
    // `'lock'` is two methods, as `Repo` has: one alone would leave both absent on the repository.
    if (capability === 'lock' && typeof raw.lockKey !== 'function') {
      throw driverCapabilityMissing(definition.name, capability, 'lockKey');
    }
  }
};

/** A `defineDriver` repository for one entity: reads, writes, locks when declared, both seams. */
const driverRepo = <Row>(
  definition: DriverDefinition,
  entity: EntityCore<Row>,
  rawFor: RawFor,
): Repo<Row> => {
  const scope = driverScope(definition, entity, rawFor);
  assertImplemented(definition, scope.raw as DriverRepo<unknown>);
  const { raw } = scope;
  // Absent unless declared, so the typed handle answers the shipped `X_LOCK_UNSUPPORTED`.
  const locks = (): Pick<Repo<Row>, 'lock' | 'lockKey'> => {
    const { lock, lockKey } = raw;
    if (lock === undefined || lockKey === undefined) return {};
    if (!definition.capabilities.includes('lock')) return {};
    return {
      async lock<R>(
        id: IdOf<Row>,
        fn: (row: Row, tx: Tx) => Promise<R> | R,
        options?: RepoOptions,
      ): Promise<R> {
        refuseAbandoned();
        const plan = scope.storePlan('lock', idPlan(entity, id, options, 'lock'));
        const tx = scope.txOf('lock', options);
        return lock.call<DriverRepo<Row>, Parameters<typeof lock<R>>, Promise<R>>(
          raw,
          { plan, tx },
          (row, held) => {
            if (row === null) throw notFound(entity.$name, id);
            const [inScope] = scope.checked('lock', plan, [row]);
            return fn(inScope ?? row, held);
          },
        );
      },
      async lockKey<R>(key: string, fn: (tx: Tx) => Promise<R> | R, options?: RepoOptions) {
        refuseAbandoned();
        return lockKey.call<DriverRepo<Row>, Parameters<typeof lockKey<R>>, Promise<R>>(
          raw,
          lockKeyInput(entity, key, options),
          fn,
          options?.tx,
        );
      },
    };
  };
  const repo: Repo<Row> = { ...driverReads(scope), ...driverWrites(scope), ...locks() };
  return appendOnlyRepo(entity, sealedRepo(entity, repo));
};

/**
 * `database(entities, { driver: defineDriver({ name, capabilities, repo }) })`. Repositories are
 * built once per entity, as `memoryDriver()`'s are, so a store keeping state per table keeps one.
 */
export const defineDriver = (definition: DriverDefinition): Driver => {
  if (definition.capabilities.includes('transactions') && definition.transactor === undefined) {
    throw driverCapabilityMissing(definition.name, 'transactions', 'transactor');
  }
  noteDriverStore('custom', definition.name);
  const repos = new Map<string, unknown>();
  // One raw store per entity, shared by its own repository and by every reference read into it.
  const raws = new Map<string, unknown>();
  const rawFor: RawFor = <R>(entity: EntityCore<R>): DriverRepo<R> => {
    const known = raws.get(entity.$name);
    if (known !== undefined) return known as DriverRepo<R>;
    const created = definition.repo(entity);
    raws.set(entity.$name, created);
    return created;
  };
  const transactor = definition.transactor;
  const reset = definition.reset;
  return {
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const existing = repos.get(entity.$name);
      // Keyed by entity name and written only from that entity, so the row type is the stored one.
      if (existing !== undefined) return existing as Repo<Row>;
      const created = driverRepo(definition, entity, rawFor);
      repos.set(entity.$name, created);
      return created;
    },
    // No `'transactions'`: a seed dry run (which writes and rolls back) refuses here, by name,
    // rather than writing for real into a store that cannot undo.
    transactor: () => {
      if (transactor === undefined) {
        throw driverUnsupported(definition.name, definition.name, 'transactor', 'transactions');
      }
      return transactor.call(definition);
    },
    ...(reset === undefined ? {} : { reset: () => reset.call(definition) }),
  };
};
