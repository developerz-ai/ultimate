// Which Postgres extensions an app's migrations create. One reader for the two embedded boots
// that must agree — `x dev`'s database (`runtime-queue.ts`) and the schema dump's scratch replay
// (`db-schema-dump.ts`): PGlite links an extension only when it is named at boot, and an app that
// replays in the gate and fails in `x dev` was the result of only one of them asking.

import type { Migration } from '@ultimat3/db';
import { readMigrations } from './migrations';

const CREATE_EXTENSION = /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z][a-z0-9_-]*)"?/gi;

/**
 * Every extension the migrations create, sorted. Matched on the raw text, comments included, on
 * purpose: over-reading costs one bundle that is never created, and a name nothing ships is
 * refused later by `create extension` itself. Blanking quoted identifiers first would lose
 * `"uuid-ossp"`, the one spelling that needs its quotes.
 */
export function migrationExtensions(migrations: readonly Migration[]): readonly string[] {
  const names = new Set<string>();
  for (const migration of migrations) {
    for (const match of migration.up.matchAll(CREATE_EXTENSION)) {
      if (match[1] !== undefined) names.add(match[1].toLowerCase());
    }
  }
  return [...names].sort();
}

/** The same list for an app on disk — what an embedded boot hands `pgliteClient`. */
export const appExtensions = async (root: string): Promise<readonly string[]> =>
  migrationExtensions(await readMigrations(root));
