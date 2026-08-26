// Single responsibility: the slice of `Bun.SQL` this package uses, declared structurally, and the
// lazy lookup of the global that provides it. Reached through a function so importing the client
// never touches `Bun` at module evaluation — the CLI imports it to print help.

import { dbUnavailable } from './errors';

/** One connection pinned out of `Bun.SQL`'s pool, released back by hand. */
export interface BunSqlReserved {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(): void;
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
