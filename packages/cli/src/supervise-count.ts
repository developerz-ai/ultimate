// How many processes one production container runs: `ULTIMATE_PROCESSES` = auto | a count. auto is
// the minimum of every clamp below and names the one that bound it; an explicit count is honoured
// and checked. ONE decision for per-process state (`unsharedState`): auto clamps on it, an
// explicit count is refused on it, and a supervised child refuses what only its boot can see.

import type { Environment, Role } from '@ultimat3/core';
import { ROLE_INFO, renderFixShellArg } from '@ultimat3/core';
import type { CgroupFacts } from './supervise-cgroup';
import {
  PROCESSES_ENV,
  ProcessesInvalidError,
  ProcessesOverPoolError,
  ProcessesRoleSingletonError,
  ProcessesUnbalancedError,
  ProcessesUnsharedStateError,
} from './supervise-errors';

/** Measured private memory of a reference-app child at peak (227 MiB), rounded up. */
export const CHILD_MEMORY_BYTES = 256 * 1024 * 1024;
/** The supervisor's own share of the ceiling, kept out before children are counted. */
export const SUPERVISOR_MEMORY_BYTES = 32 * 1024 * 1024;

export type ProcessesRequest = 'auto' | number;

/** `auto` (also unset or blank) or a positive whole number; anything else refuses. */
export function readProcessesRequest(
  env: Readonly<Record<string, string | undefined>>,
): ProcessesRequest {
  const raw = env[PROCESSES_ENV]?.trim() ?? '';
  if (raw === '' || raw === 'auto') return 'auto';
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ProcessesInvalidError(raw);
  }
  return Number(raw);
}

/** A store the boot was handed, by the name an operator finds it under in `runtime.ts`. */
export interface StoreScope {
  readonly name: string;
  readonly scope: string | undefined;
}

export interface SharedStateFacts {
  readonly role: Role;
  /** `cache.tiers` names `lru`. */
  readonly lruTier: boolean;
  /** `NATS_URL` is set, or `runtime.ts` supplied a transport that is not the in-process bus. */
  readonly crossingBus: boolean;
  /** `REDIS_URL` / `VALKEY_URL`: the cache's invalidations ride Redis pub/sub. */
  readonly redis: boolean;
  /** No `DATABASE_URL`: PGlite in a directory one process owns. */
  readonly embeddedDatabase: boolean;
  readonly stores: readonly StoreScope[];
}

/**
 * The stores among `stores` whose scope is not `'shared'`. Its own export because one store is only
 * seen by a child, after the app's modules ran (`runtime-idempotency-scope.ts`): same rule, later.
 */
export const unsharedStores = (stores: readonly StoreScope[]): readonly string[] =>
  stores
    .filter((store) => store.scope !== 'shared')
    .map(
      (store) =>
        `${store.name} keeps its records per process (scope ${store.scope ?? 'undeclared'})`,
    );

/** Every piece of state N children would each keep to themselves, as a cause names it. */
export function unsharedState(facts: SharedStateFacts): readonly string[] {
  return [
    ...(facts.lruTier && !facts.crossingBus && !facts.redis
      ? [
          'the lru cache tier, whose invalidations ride the in-process bus (no NATS_URL or REDIS_URL)',
        ]
      : []),
    ...unsharedStores(facts.stores),
    ...(facts.embeddedDatabase
      ? ['the embedded database (no DATABASE_URL), one directory per process']
      : []),
    ...(facts.role === 'sync' && !facts.crossingBus
      ? ['the sync role with no NATS_URL: channel fan-out and presence stay inside one process']
      : []),
  ];
}

/** What the resolver reads. Every source is injected, so each branch is a unit test. */
export interface CountSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly role: Role;
  readonly platform: string;
  readonly environment: Environment | undefined;
  readonly cgroup: () => Promise<CgroupFacts>;
  /** `availableParallelism()`: the cpuset bound under a quota. */
  readonly parallelism: () => number;
  /** The container's pool: `DATABASE_POOL_MAX`, else the role's profile. */
  readonly pool: () => number;
  readonly shared: () => Promise<SharedStateFacts>;
  /** The image carries `x build --target prebuilt`'s store; a boot without it compiles. */
  readonly prebuilt: () => Promise<boolean>;
}

export type ClampName =
  | 'environment'
  | 'platform'
  | 'role'
  | 'cpu'
  | 'memory'
  | 'pool'
  | 'shared-state'
  | 'image'
  | 'requested';

export interface ProcessCount {
  readonly count: number;
  readonly requested: ProcessesRequest;
  /** The clamp that set the count: what the boot line names. */
  readonly binding: ClampName;
  /** Each clamp's value, in the order auto takes their minimum. */
  readonly clamps: Readonly<Partial<Record<ClampName, number>>>;
  /** A line the boot owes beside the count: an ignored request, a count above the memory fit. */
  readonly note?: {
    readonly level: 'info' | 'warn';
    readonly msg: string;
    readonly cause: string;
    readonly fix?: string;
  };
}

const memoryFit = (bytes: number | undefined): number | undefined =>
  bytes === undefined
    ? undefined
    : Math.max(1, Math.floor((bytes - SUPERVISOR_MEMORY_BYTES) / CHILD_MEMORY_BYTES));

const singleton = (role: Role): boolean => ROLE_INFO[role].maxReplicas === 1;

const PRODUCTION_LIKE: ReadonlySet<Environment | undefined> = new Set(['production', 'staging']);

/** The minimum of the clamps that are bounded; the first one at that minimum is the binding. */
function lowest(clamps: Partial<Record<ClampName, number>>): {
  count: number;
  binding: ClampName;
} {
  let best: { count: number; binding: ClampName } = {
    count: Number.POSITIVE_INFINITY,
    binding: 'cpu',
  };
  for (const [name, value] of Object.entries(clamps) as [ClampName, number][]) {
    if (value < best.count) best = { count: value, binding: name };
  }
  return best;
}

async function resolveAuto(sources: CountSources): Promise<ProcessCount> {
  if (sources.platform !== 'linux') return one('platform', { platform: 1 });
  if (singleton(sources.role)) return one('role', { role: 1 });
  const cgroup = await sources.cgroup();
  // No quota declared reads as one process: a quota-less pod must never read the node's cores.
  if (cgroup.cpus === undefined) return one('cpu', { cpu: 1 });
  const fit = memoryFit(cgroup.memoryBytes);
  // Insertion order IS the tie-break: the first clamp at the minimum is the one the line names.
  const clamps: Partial<Record<ClampName, number>> = {
    cpu: Math.min(cgroup.cpus, Math.max(1, sources.parallelism())),
    ...(fit === undefined ? {} : { memory: fit }),
    pool: sources.pool(),
    ...(unsharedState(await sources.shared()).length === 0 ? {} : { 'shared-state': 1 }),
    ...((await sources.prebuilt()) ? {} : { image: 1 }),
  };
  return { ...lowest(clamps), requested: 'auto', clamps };
}

const one = (binding: ClampName, clamps: Partial<Record<ClampName, number>>): ProcessCount => ({
  count: 1,
  requested: 'auto',
  binding,
  clamps,
});

async function checkExplicit(sources: CountSources, requested: number): Promise<ProcessCount> {
  if (requested === 1) return { count: 1, requested, binding: 'requested', clamps: {} };
  if (singleton(sources.role))
    throw new ProcessesRoleSingletonError({ role: sources.role, requested });
  if (sources.platform !== 'linux') {
    throw new ProcessesUnbalancedError({ requested, platform: sources.platform });
  }
  const reasons = unsharedState(await sources.shared());
  if (reasons.length > 0) throw new ProcessesUnsharedStateError({ requested, reasons });
  const pool = sources.pool();
  if (requested > pool) throw new ProcessesOverPoolError({ requested, pool });
  const fit = memoryFit((await sources.cgroup()).memoryBytes);
  const result: ProcessCount = {
    count: requested,
    requested,
    binding: 'requested',
    clamps: { pool, ...(fit === undefined ? {} : { memory: fit }) },
  };
  if (fit === undefined || requested <= fit) return result;
  return {
    ...result,
    note: {
      level: 'warn',
      msg: 'ultimate processes above the memory fit',
      cause: `${PROCESSES_ENV}=${String(requested)} children at about 256 MiB each fit ${String(fit)} into this container's memory ceiling, so an OOM kill takes a child under load`,
      fix: `${PROCESSES_ENV}=${renderFixShellArg(String(fit), '<count>')}   # or raise the service's memory limit (mem_limit, resources.limits.memory)`,
    },
  };
}

/**
 * The count, or a coded refusal. Only a production-like container supervises: `x dev`, the test
 * runner and any other environment run one process, and a count asked for there is ignored with
 * one info line rather than refused — a `.env` shared with production must not stop a laptop.
 */
export async function resolveProcessCount(sources: CountSources): Promise<ProcessCount> {
  const requested = readProcessesRequest(sources.env);
  if (!PRODUCTION_LIKE.has(sources.environment)) {
    return {
      count: 1,
      requested,
      binding: 'environment',
      clamps: { environment: 1 },
      ...ignoredRequest(requested, sources.environment ?? 'unnamed'),
    };
  }
  return requested === 'auto' ? resolveAuto(sources) : checkExplicit(sources, requested);
}

/**
 * The one line a process that always runs as one owes a count asked of it: the test runner and any
 * non-production environment here, `x dev` (`dev-boot.ts`) everywhere. Nothing for auto or `1`.
 */
export function ignoredRequest(
  requested: ProcessesRequest,
  where: string,
): { readonly note?: NonNullable<ProcessCount['note']> } {
  if (requested === 'auto' || requested === 1) return {};
  return {
    note: {
      level: 'info',
      msg: 'ultimate processes ignored',
      cause: `${PROCESSES_ENV}=${String(requested)} applies to production containers only; this ${where} process runs as one`,
    },
  };
}
