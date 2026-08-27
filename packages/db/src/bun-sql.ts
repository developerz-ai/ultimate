// Single responsibility: the slice of `Bun.SQL` this package uses, declared structurally, the lazy
// lookup of the global that provides it, and the one safe way to hand a pinned connection back.
// Reached through a function so importing the client never touches `Bun` at module evaluation —
// the CLI imports it to print help.

import { logger, renderThrowable } from '@ultimat3/core';
import { dbUnavailable } from './errors';

/** One connection pinned out of `Bun.SQL`'s pool, released back by hand. */
export interface BunSqlReserved {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  /**
   * **Answers a PROMISE, and typing it `void` is what made both callers float it.** Measured on
   * Bun 1.3.14 and 1.4.0 against a real server: `release()` returns a promise on both, and on
   * 1.3.14 that promise REJECTS with `ERR_POSTGRES_CONNECTION_CLOSED` when the pool has already
   * been closed. Nothing was attached to it, so it surfaced as an UNHANDLED REJECTION — which Bun
   * takes the process down for. `unknown` rather than `Promise<void>` because a fake reserved
   * connection returns nothing at all, and the caller has to handle both anyway.
   */
  release(): unknown;
}

/**
 * Hand a pin back, totally. The one place that knows `release()` answers a promise, so neither
 * caller can forget it (axiom 1) — `client.ts`'s `DbConnection.release` and `pool-reserve.ts`'s
 * late arrival both route here.
 *
 * A failed release is **best-effort, exactly where a throw would mask the error that caused it** —
 * the rule this package already applies to `ROLLBACK`. `[Symbol.dispose]` is `DbConnection.release`
 * itself, so a throw there replaces whatever error reached the `using` block, or invents one where
 * the body succeeded. And the news is unactionable: the connection this would hand back is gone
 * either way.
 *
 * Reachable, and reachable BECAUSE `close()` is bounded: an abandoned drain leaves every
 * still-pinned connection to be released against a pool that no longer exists.
 */
export function releaseReserved(reserved: BunSqlReserved): void {
  const report = (error: unknown): void => {
    logger.debug('db.release_failed', { error: renderThrowable(error) });
  };
  let settled: unknown;
  try {
    settled = reserved.release();
  } catch (error) {
    report(error);
    return;
  }
  // `then` and not `instanceof Promise`: the value comes from the driver, and a thenable is the
  // contract every await in this package already relies on.
  if (typeof (settled as PromiseLike<unknown> | undefined)?.then === 'function') {
    void (settled as PromiseLike<unknown>).then(undefined, report);
  }
}

/** The slice of `Bun.SQL` we use. Declared structurally so this package has no dependency. */
export interface BunSqlDriver {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  reserve(): Promise<BunSqlReserved>;
  close(options?: { readonly timeout?: number }): Promise<void>;
}

export type BunSqlFactory = new (
  url: string,
  options?: Readonly<Record<string, unknown>>,
) => BunSqlDriver;

export function bunSqlFactory(): BunSqlFactory {
  const host = globalThis as unknown as { readonly Bun?: { readonly SQL?: unknown } };
  const factory = host.Bun?.SQL;
  if (typeof factory !== 'function') {
    throw dbUnavailable('Bun.SQL is unavailable — this package requires Bun >= 1.3');
  }
  return factory as BunSqlFactory;
}
