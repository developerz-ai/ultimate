// Single responsibility: the embedded development database, so `x dev` needs no Docker and no
// DATABASE_URL. The `DbClient` surface is complete; the PGlite WASM binding is the one piece
// deferred, and it fails with a labelled X_NOT_IMPLEMENTED carrying the command that fixes it
// rather than a mystery module-resolution error at 9am on someone's first day.

import { notImplemented } from '@ultimat3/core';
import type { DbClient } from './client';
import { dbNotImplemented } from './errors';
import type { SqlFragment } from './sql';

/** The slice of PGlite we need. Declared structurally — this package has no dependencies. */
export interface PgliteDriver {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
  exec?(text: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface PgliteOptions {
  /** `memory://` (default) or a directory. Preview branches use a directory per branch. */
  readonly dataDir?: string | undefined;
  /** Inject a driver — the CLI does this once `@electric-sql/pglite` is a real dependency. */
  readonly driver?: PgliteDriver | undefined;
}

export const PGLITE_FIX =
  'bun add @electric-sql/pglite, or set DATABASE_URL to a Postgres server and re-run';

/** Deferred: PGlite ships as WASM and is not vendored yet. */
export function loadPgliteDriver(options: PgliteOptions = {}): PgliteDriver {
  if (options.driver !== undefined) return options.driver;
  const dataDir = options.dataDir ?? 'memory://';
  return notImplemented(`the embedded PGlite driver (dataDir=${dataDir})`, PGLITE_FIX);
}

export interface PgliteClient extends DbClient {
  close(): Promise<void>;
}

export function createPgliteClient(options: PgliteOptions = {}): PgliteClient {
  let driver: PgliteDriver | undefined = options.driver;

  function connect(): PgliteDriver {
    driver ??= loadPgliteDriver(options);
    return driver;
  }

  async function rows(fragment: SqlFragment): Promise<readonly unknown[]> {
    const result = await connect().query(fragment.text, fragment.values);
    return result.rows;
  }

  return {
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      return (await rows(fragment)) as readonly T[];
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      const result = await rows(fragment);
      return (result[0] as T | undefined) ?? null;
    },
    async execute(fragment: SqlFragment): Promise<number> {
      return (await rows(fragment)).length;
    },
    async close(): Promise<void> {
      await driver?.close();
      driver = undefined;
    },
  };
}

/** `x db branch` against PGlite copies the data directory; there is no TEMPLATE to copy. */
export function branchPglite(): never {
  throw dbNotImplemented(
    'copy-on-write branching on PGlite',
    'x db branch --driver postgres   # branching needs CREATE DATABASE ... TEMPLATE',
  );
}
