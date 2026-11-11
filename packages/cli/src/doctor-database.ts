// `x doctor`'s database checks: the external Postgres answers `select 1`, and the embedded PGlite
// the app would open where there is none is installed. Facts read here, decided by pure rules.

// why: Bun has no synchronous file-exists or path-walking API; the peer is found on disk, never loaded.
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { checkDb, postgresClient } from '@ultimat3/db';
import type { Finding } from './output';
import { findingFrom } from './output';

const finding = (code: string, cause: string, fix: string): Finding => ({
  code,
  cause,
  fix,
  docs: ERROR_DOCS_URL,
});

/**
 * `DATABASE_URL` as BOTH halves of the database question read it: unset and blank are one case.
 * One seam, because the two halves are complementary — a second reading of the same variable is
 * how a configuration ends up reported by neither probe, or by both.
 */
export const externalUrl = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : raw;

/**
 * Is the optional peer INSTALLED for this app — a `node_modules` walk up from the app root.
 *
 * Never an IMPORT: loading PGlite boots 26 MB of WASM and takes the single-writer lock the next
 * command needs, and a diagnostic must not be the reason `x dev` cannot open the database it just
 * reported on.
 *
 * Never `Bun.resolveSync` either, which was this check's first draft. It falls back to Bun's
 * machine-global install cache: measured 2026-09-11 against a freshly scaffolded app with no
 * `node_modules` anywhere above it, `Bun.resolveSync('@electric-sql/pglite', <app>)` answered
 * `~/.bun/install/cache/@electric-sql/pglite@0.5.8@@@1/dist/index.js` — a version the app does not
 * depend on, in a directory `bun install` never wrote for it. A box that had downloaded the package
 * ONCE, for anything, would have read as ready on every app after it, which is the exact opposite
 * of the question. The walk asks what `bun add` answers, and nothing else.
 *
 * Up from the root and not at it, because an app checked out inside a larger workspace is installed
 * by the hoisting one: `examples/dummy` in this repository has no `node_modules` of its own.
 */
export const installedAbove = (dir: string, specifier: string): boolean => {
  let current = resolve(dir);
  // Bounded by the path itself — one segment per step — rather than by `for (;;)` and the promise
  // that `dirname('/')` is `/`. The loop still stops on that, one step earlier.
  for (let remaining = current.split(sep).length; remaining > 0; remaining -= 1) {
    if (existsSync(join(current, 'node_modules', specifier, 'package.json'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
};

/**
 * A real `select 1` through the app's own driver, not a TCP connect: a running Postgres with the
 * wrong credentials or a database that does not exist accepts the socket and refuses the session,
 * which is the case an operator most needs told about before a deploy.
 *
 * The pool is CLOSED on every path — this command exits, and a held pool is a connection slot the
 * next `x db migrate` cannot have.
 */
export async function probeDatabase(
  url: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Finding | null> {
  if (externalUrl(url) === undefined) return null;
  let client: ReturnType<typeof postgresClient>;
  try {
    client = postgresClient({ url, env, applicationName: 'x-doctor' });
  } catch (error) {
    return findingFrom(error);
  }
  try {
    const report = await checkDb(client);
    if (report.ok) return null;
    // `DbHealthReport.error` is `checkDb`'s own rendering of what refused, never this file's — the
    // caught value is `checkDb`'s to read, and it is the one function that already reads it safely.
    return finding(
      'X_DB_UNAVAILABLE',
      `DATABASE_URL does not answer \`select 1\`: ${report.error ?? 'no reason reported'}`,
      // `dbUnavailable`'s own two branches, verbatim: a second wording for one condition is two
      // answers to "what do I do", and this one is reached first, before any command opens a pool.
      'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    );
  } finally {
    await client.close();
  }
}
