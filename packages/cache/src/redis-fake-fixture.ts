// The fake `Bun.redis` the redis test files drive, and the wire readers they assert with. It holds
// values and sorted sets as state, because those are plain commands; it never interprets Lua, and
// every claim about what a script DOES lives in `redis.live.test.ts`. Not exported from
// `index.ts` — a test double shaped around this package's own assertions, not public API.

import { CacheDriverUnavailableError } from './errors';
import type { RedisLike, RedisTierOptions } from './redis';
import { redisTier } from './redis';
import { REDIS_TAG_LEASE_SCRIPT } from './redis-buckets';
import type { CacheTier } from './tiers';

export interface FakeRedis extends RedisLike {
  readonly sent: string[][];
  /** Makes one value key's `UNLINK`/`DEL` refuse, which is the half of a bust that can fail alone. */
  refuseDel(key: string): void;
  /** The members of one bucket, in score order — what the server holds, not what was sent. */
  members(bucket: string): string[];
}

/** `-inf`, `+inf`, `(n` (exclusive) and `n`, as `ZREMRANGEBYSCORE` reads a bound. */
function bound(text: string): { readonly value: number; readonly open: boolean } {
  if (text === '-inf') return { value: Number.NEGATIVE_INFINITY, open: false };
  if (text === '+inf') return { value: Number.POSITIVE_INFINITY, open: false };
  if (text.startsWith('(')) return { value: Number(text.slice(1)), open: true };
  return { value: Number(text), open: false };
}

const within = (score: number, min: string, max: string): boolean => {
  const lo = bound(min);
  const hi = bound(max);
  const aboveLo = lo.open ? score > lo.value : score >= lo.value;
  const belowHi = hi.open ? score < hi.value : score <= hi.value;
  return aboveLo && belowHi;
};

/** Score order, then member order — the server's own tie-break. */
const ordered = (zset: Map<string, number>): [string, number][] =>
  [...zset].sort(([left, a], [right, b]) => a - b || (left < right ? -1 : left > right ? 1 : 0));

export function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  // The lease `PX` bought, in ms. A fake that answered no `PTTL` could not catch a tier that
  // stopped asking for one — and a hit read back without its remaining life is promoted on the
  // caller's ttl, which is how a value one second from expiry gets a fresh five minutes.
  const expiries = new Map<string, number>();
  const zsets = new Map<string, Map<string, number>>();
  // Every member a set ever held, in first-insertion order and never compacted: `ZSCAN`'s cursor
  // is an index into it, so removals and re-scores shift nothing — the guarantee Redis documents
  // (a member present for the whole scan is returned), and nothing stronger.
  const scanLogs = new Map<string, string[]>();
  const logged = new Map<string, Set<string>>();
  const sent: string[][] = [];
  const refused = new Set<string>();
  // Lowest score per set, so a prune with nothing to remove costs nothing: 10k writes each pruning
  // a 10k-member set is otherwise 10^8 steps of fake, not of tier. Dropped on removal, rebuilt lazily.
  const floors = new Map<string, number>();
  const floorOf = (key: string, zset: Map<string, number>): number => {
    const known = floors.get(key);
    if (known !== undefined) return known;
    const lowest = Math.min(...zset.values());
    floors.set(key, lowest);
    return lowest;
  };

  const zsetOf = (key: string): Map<string, number> => {
    const found = zsets.get(key) ?? new Map<string, number>();
    zsets.set(key, found);
    return found;
  };
  // A key the server removed is a new key when it comes back: its scan starts over.
  const forget = (key: string): void => {
    scanLogs.delete(key);
    logged.delete(key);
  };
  // An emptied sorted set is a key the server removes, so the fake does too.
  const settle = (key: string): void => {
    if (zsets.get(key)?.size !== 0) return;
    zsets.delete(key);
    forget(key);
  };
  const remove = (key: string): Promise<number> => {
    if (refused.has(key)) return Promise.reject(new Error(`redis refused UNLINK ${key}`));
    floors.delete(key);
    forget(key);
    const existed = values.delete(key) || zsets.delete(key);
    expiries.delete(key);
    return Promise.resolve(existed ? 1 : 0);
  };

  return {
    sent,
    refuseDel(key) {
      refused.add(key);
    },
    members(bucket) {
      return ordered(zsets.get(bucket) ?? new Map()).map(([member]) => member);
    },
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    set(key, value) {
      values.set(key, value);
      return Promise.resolve('OK');
    },
    send(command, args) {
      sent.push([command, ...args]);
      const key = String(args[0]);
      switch (command) {
        case 'SET':
          values.set(key, String(args[1]));
          if (args[2] === 'PX') expiries.set(key, Number(args[3]));
          return Promise.resolve('OK');
        case 'PTTL':
          if (!values.has(key)) return Promise.resolve(-2);
          return Promise.resolve(expiries.get(key) ?? -1);
        case 'DEL':
        case 'UNLINK':
          return remove(key);
        case 'ZADD': {
          const zset = zsetOf(key);
          for (let i = 1; i + 1 < args.length; i += 2) {
            const score = Number(args[i]);
            const member = String(args[i + 1]);
            // A re-scored member may have been the floor; recompute rather than guess.
            if (zset.has(member)) floors.delete(key);
            const seen = logged.get(key) ?? new Set<string>();
            if (!seen.has(member)) {
              seen.add(member);
              logged.set(key, seen);
              const log = scanLogs.get(key) ?? [];
              log.push(member);
              scanLogs.set(key, log);
            }
            zset.set(member, score);
            const floor = floors.get(key);
            if (floor !== undefined) floors.set(key, Math.min(floor, score));
          }
          return Promise.resolve(1);
        }
        case 'ZREMRANGEBYSCORE': {
          const zset = zsets.get(key) ?? new Map<string, number>();
          let removed = 0;
          const max = String(args[2]);
          if (zset.size === 0 || !within(floorOf(key, zset), '-inf', max)) {
            return Promise.resolve(0);
          }
          floors.delete(key);
          for (const [member, score] of zset) {
            if (within(score, String(args[1]), String(args[2])) && zset.delete(member)) removed++;
          }
          settle(key);
          return Promise.resolve(removed);
        }
        case 'ZSCAN': {
          const log = scanLogs.get(key) ?? [];
          const zset = zsets.get(key) ?? new Map<string, number>();
          const from = Number(args[1]);
          const count = Number(args[args.indexOf('COUNT') + 1] ?? 10);
          const to = Math.min(from + count, log.length);
          const flat = log
            .slice(from, to)
            .flatMap((member) => (zset.has(member) ? [member, String(zset.get(member))] : []));
          return Promise.resolve([to >= log.length ? '0' : String(to), flat]);
        }
        case 'ZREM': {
          const zset = zsets.get(key) ?? new Map<string, number>();
          const removed = args.slice(1).filter((member) => zset.delete(member)).length;
          floors.delete(key);
          settle(key);
          return Promise.resolve(removed);
        }
        case 'ZSCORE':
          return Promise.resolve(zsets.get(key)?.get(String(args[1])) ?? null);
        case 'ZCARD':
          return Promise.resolve(zsets.get(key)?.size ?? 0);
        case 'EVAL':
          // Nothing reads the lease script's reply, so a constant here asserts nothing about it.
          // Any other script is a claim this fake cannot check — refused, loudly, with a code.
          if (args[0] === REDIS_TAG_LEASE_SCRIPT) return Promise.resolve(1);
          throw new CacheDriverUnavailableError({
            driver: 'fake redis',
            cause: 'the fake cannot execute EVAL, and a script reply it made up would be the test',
            fix: 'move the claim to packages/cache/src/redis.live.test.ts, which runs the script on a real server',
          });
        default:
          return Promise.resolve(null);
      }
    },
  };
}

/**
 * Every command resolves at the next macrotask, together with every other command sent in the same
 * synchronous burst — what Bun's pipelining makes of a `Promise.all`. `trips()` counts the bursts:
 * the sequential awaits a path costs, which is what a 100k-member bust on the post-commit path pays.
 */
export function roundTrips(inner: RedisLike): RedisLike & { trips(): number } {
  let trips = 0;
  let queued: (() => void)[] = [];
  const flush = (): void => {
    trips += 1;
    const due = queued;
    queued = [];
    for (const run of due) run();
  };
  const later = <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (queued.length === 0) setTimeout(flush, 0);
      queued.push(() => {
        work().then(resolve, reject);
      });
    });
  return {
    trips: () => trips,
    get: (key) => later(() => inner.get(key)),
    set: (key, value) => later(() => inner.set(key, value)),
    send: (command, args) => later(() => inner.send(command, args)),
  };
}

/**
 * `buildId: null` and `rng: () => 0` are the two things a wire assertion needs pinned: the
 * namespace carries the build id by default, and the lease is spread by default.
 */
export function tierFor(client: RedisLike, extra: RedisTierOptions = {}): CacheTier {
  return redisTier({ client, buildId: null, rng: () => 0, ...extra });
}

/** The `{...}` hash tag of a key, which is what Redis Cluster hashes to a slot. */
export function slotTokenOf(key: string): string {
  return /\{([^}]*)\}/.exec(key)?.[1] ?? key;
}

/**
 * The key argument of one command. `EVAL script numkeys k1 .. kN` names its own; every other
 * command this tier sends takes exactly one key first, and its members are values, not keys.
 */
export function keysOf(command: readonly string[]): string[] {
  if (command[0] === 'EVAL') return command.slice(3, 3 + Number(command[2]));
  return command.length > 1 ? command.slice(1, 2) : [];
}

/** The buckets a bust READ, in call order — one `ZSCAN` page each. */
export const bucketsRead = (sent: readonly string[][]): string[] => [
  ...new Set(sent.filter((entry) => entry[0] === 'ZSCAN').map((entry) => String(entry[1]))),
];

/** The buckets a write JOINED, in call order. */
export const bucketsJoined = (sent: readonly string[][]): string[] =>
  sent.filter((entry) => entry[0] === 'ZADD').map((entry) => String(entry[1]));
