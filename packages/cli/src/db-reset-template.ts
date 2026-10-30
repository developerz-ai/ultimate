// `x db reset`'s embedded fast path: the emptied data directory is laid down from the migrated
// TEMPLATE (`test-database.ts`: framework schema + every migration, cached under `.x/test-db` and
// keyed on everything that went into it) instead of an `initdb` and every migration replayed one by
// one. The migrate that follows still runs and finds every migration in the ledger — so a template
// that is missing something is completed by it, never trusted over it. Measured on
// bank-integrations (33 migrations, a loaded 12-core box, 3 runs each): `x db reset` 8.7 s → 7.5 s.
// What is left is the CLI's boot, the migrator's no-op pass and the schema dump's own replay (~3 s,
// `db-schema-refresh.ts`). The e2e step's app boots through exactly this reset, once per gate.

// why: Bun has no recursive remove; a failed lay-down must leave the directory as `rm` left it.
import { rm } from 'node:fs/promises';
import { raw } from '@ultimat3/db';
import { appExtensions } from './migration-extensions';
import { migratedDatabase } from './test-database';

export interface TemplateLayDeps {
  /** Boots a database from the template at `dataDir`; `test-database.ts`'s by default. */
  readonly open?: typeof migratedDatabase;
  readonly extensions?: (root: string) => Promise<readonly string[]>;
}

/**
 * `true` when `dataDir` now holds the migrated template. Best effort and never a throw: anything
 * that fails removes what it wrote, and the caller's migrate builds the database the slow way.
 */
export async function layTemplate(
  root: string,
  dataDir: string,
  deps: TemplateLayDeps = {},
): Promise<boolean> {
  const open = deps.open ?? migratedDatabase;
  try {
    const extensions = await (deps.extensions ?? appExtensions)(root);
    const client = await open({ root, dataDir, extensions });
    try {
      // The boot is lazy: one statement is what makes PGlite restore the template onto the disk.
      await client.execute(raw('select 1'));
    } finally {
      await client.close();
    }
    return true;
  } catch {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
}
