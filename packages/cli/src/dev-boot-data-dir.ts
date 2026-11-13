// `x dev`'s answer to an embedded data directory that will not open: set it aside under a dated
// suffix, boot a fresh one, and say so (`X_DEV_DATA_UNOPENABLE`, a notice, never a refusal). The
// boot used to fail with `X_DB_UNAVAILABLE`, whose fix was to run the command that had just failed.

// why: Bun ships no rename or exists API for a directory.
import { existsSync, renameSync } from 'node:fs';
import { renderThrowable } from '@ultimat3/core';
import { pgliteClient, pgliteDataDir, sql } from '@ultimat3/db';
import type { Finding } from './output';
import type { ServiceBinding } from './runtime-bindings';

/** `<dir>.unopenable-<UTC instant>`: sorts by date, and no two boots a second apart collide. */
export const asideName = (dataDir: string, now: Date): string =>
  `${dataDir}.unopenable-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;

/** Whether PGlite opens `dataDir` and answers one statement. Costs a PGlite boot. */
export async function pgliteOpens(
  dataDir: string,
  extensions: () => Promise<readonly string[]>,
): Promise<boolean> {
  const client = pgliteClient({ dataDir, extensions });
  try {
    await client.query(sql`select 1`);
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export interface StartOverOptions<T> {
  /** The boot: `startServices`, run a second time over the fresh directory. */
  readonly start: () => Promise<T>;
  /** Asked only after `start` failed: does the directory open on its own? */
  readonly opens: (dataDir: string) => Promise<boolean>;
  readonly now: () => Date;
}

/**
 * `start()`, and when it fails over an embedded directory that exists and does not open by itself,
 * that directory renamed aside and `start()` once more. Every other failure — an external database,
 * a first boot with nothing on disk, a directory that opens — is rethrown untouched: moving a
 * developer's data is only ever the answer to that data being unreadable. Renamed, never deleted.
 */
export async function startOverUnopenable<T>(
  binding: ServiceBinding,
  options: StartOverOptions<T>,
): Promise<{ readonly value: T; readonly notice?: Finding }> {
  try {
    return { value: await options.start() };
  } catch (error) {
    if (binding.mode !== 'embedded') throw error;
    const dataDir = pgliteDataDir(binding.url);
    if (!existsSync(dataDir) || (await options.opens(dataDir))) throw error;
    const aside = asideName(dataDir, options.now());
    renameSync(dataDir, aside);
    const notice: Finding = {
      code: 'X_DEV_DATA_UNOPENABLE',
      cause: `the embedded database at ${dataDir} would not open (${renderThrowable(error)}), so it was moved to ${aside} and this boot started an empty one — the app's tables and rows are in the moved directory, not in this database`,
      fix: 'x db migrate',
      meta: { dataDir, aside },
    };
    return { value: await options.start(), notice };
  }
}
