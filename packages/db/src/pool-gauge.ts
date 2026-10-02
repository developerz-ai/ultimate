// Single responsibility: how much of its Postgres pools this process is asking for, as three
// series. `Bun.SQL` publishes no occupancy — no open, idle or queued count — so this counts DEMAND
// at the one place every statement and every pin passes (`client.ts`) and derives the rest: a
// statement or a pin beyond `max` is waiting for a connection, by the pool's own rule.

import { gauge } from '@ultimat3/core';

/** One pool's ceiling and the units of work currently asking it for a connection. */
export interface PoolDemand {
  /** A statement was sent, or a pin was asked for. */
  enter(): void;
  /** That statement settled, or that pin came back. */
  leave(): void;
  /** The pool closed: it stops counting toward the totals until it is asked again. */
  close(): void;
}

interface Tracked {
  readonly max: number;
  demand: number;
}

const pools = new Set<Tracked>();
let declared = false;

const total = (pick: (pool: Tracked) => number) => (): number => {
  let sum = 0;
  for (const pool of pools) sum += pick(pool);
  return sum;
};

/** On the first tracked pool, never at import: a process that opens no pool declares no series. */
function declare(): void {
  if (declared) return;
  declared = true;
  gauge('db_pool_max', {
    unit: '{connection}',
    description: 'Connections this process may open, summed over its pools',
    observe: total((pool) => pool.max),
  });
  gauge('db_pool_in_use', {
    unit: '{connection}',
    description: 'Connections running a statement or pinned by a transaction',
    observe: total((pool) => Math.min(pool.demand, pool.max)),
  });
  gauge('db_pool_waiting', {
    unit: '{statement}',
    description: 'Statements and pins queued for a connection because the pool is at its ceiling',
    observe: total((pool) => Math.max(0, pool.demand - pool.max)),
  });
}

/** One pool's counter. Registered on its first use, so a client nobody queries counts for nothing. */
export function trackPool(max: number): PoolDemand {
  const pool: Tracked = { max, demand: 0 };
  return {
    enter(): void {
      declare();
      pools.add(pool);
      pool.demand += 1;
    },
    leave(): void {
      // Floored: a second `leave` for one `enter` must not hide a later statement.
      pool.demand = Math.max(0, pool.demand - 1);
    },
    close(): void {
      pools.delete(pool);
    },
  };
}
