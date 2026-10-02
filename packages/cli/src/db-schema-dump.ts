// The app's schema dump — `packages/db/schema/` — produced, read and written. ONE producer: a
// scratch database (`db-replay-engine.ts` says which) with the framework's tables applied and
// every migration replayed, never the developer's own database. `x db gen`, `x db migrate` and the `drift` step all call it,
// so the bytes the gate compares against are the bytes the commands wrote, on one engine.

// why: Bun has no directory probe — `Bun.file().exists()` answers about a file.
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { Migration } from '@ultimat3/db';
import { migrate, raw } from '@ultimat3/db';
import type {
  CatalogDescription,
  SchemaDumpDifference,
  SchemaDumpFile,
} from '@ultimat3/db/schema-dump';
import {
  introspectCatalog,
  loadSchemaDump,
  reloadDifferences,
  renderSchemaDump,
  schemaDumpDifferenceOf,
} from '@ultimat3/db/schema-dump';
import { chooseReplayEngine, withScratchDatabase } from './db-replay-engine';
import { applyFrameworkSchema } from './framework-schema';
import { resolveServices } from './runtime-bindings';

/** Where the dump lives. App-root-relative, POSIX — beside `MIGRATIONS_DIR`, its one source. */
export const SCHEMA_DUMP_DIR = 'packages/db/schema';

export interface ReplayedSchema {
  readonly catalog: CatalogDescription;
  readonly files: readonly SchemaDumpFile[];
  /** Empty when a database loaded from `files` renders `files` again. Always empty without `reload`. */
  readonly reload: readonly SchemaDumpDifference[];
}

export interface ReplayOptions {
  /** Also prove load equals replay: reset the schema, load the dump, render it again. */
  readonly reload?: boolean | undefined;
  /** The app's state directory (`.x/`), where the embedded scratch boot keeps its snapshot. */
  readonly stateDir?: string | undefined;
  /** Read for the server URL when the migrations cannot replay on the embedded database. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Framework tables first, then every migration — the order every real boot runs them in
 * (`startQueue`, then `migrate`), so a migration's foreign key into `x_users` finds its target.
 * The client is handed to each call and never installed as the ambient `db()`: this runs inside
 * `x verify`, beside steps that own that accessor.
 *
 * The reload reuses the SAME database, emptied — a second scratch database is a second boot for a
 * question `drop schema … cascade` answers as well. It is asked only of a dump that claims to be
 * whole: one that lists objects in `unrendered.sql` has already said a database loaded from it is
 * not the migrated one.
 */
export async function replaySchema(
  migrations: readonly Migration[],
  options: ReplayOptions = {},
): Promise<ReplayedSchema> {
  const engine = await chooseReplayEngine(migrations, options.env ?? Bun.env);
  return withScratchDatabase(engine, options.stateDir, async (client) => {
    await applyFrameworkSchema((statement) => client.execute(raw(statement)));
    await migrate({ migrations, client });
    const catalog = await introspectCatalog({ client });
    const files = renderSchemaDump(catalog);
    if (options.reload !== true || catalog.unrendered.length > 0) {
      return { catalog, files, reload: [] };
    }
    await client.execute(raw('drop schema public cascade'));
    await client.execute(raw('create schema public'));
    try {
      await loadSchemaDump({ client, files });
    } catch (error) {
      // A refusal to load is a verdict about the dump, not a failed replay: reported as the
      // difference it is, so the caller's finding names the file rather than the engine.
      const refused = schemaDumpDifferenceOf(error);
      if (refused === undefined) throw error;
      return { catalog, files, reload: [refused] };
    }
    const reloaded = renderSchemaDump(await introspectCatalog({ client }));
    return { catalog, files, reload: reloadDifferences(files, reloaded) };
  });
}

/** The replay for an app on disk: its own state directory, its command's environment. */
export const replayFor = (
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  reload: boolean,
): ((migrations: readonly Migration[]) => Promise<ReplayedSchema>) => {
  return (migrations) =>
    replaySchema(migrations, { reload, env, stateDir: resolveServices(root, env).stateDir });
};

export const hasSchemaDump = (root: string): boolean => existsSync(join(root, SCHEMA_DUMP_DIR));

/** Every `.sql` under the dump directory, sorted by path — the shape `renderSchemaDump` answers in. */
export async function readSchemaDump(root: string): Promise<readonly SchemaDumpFile[]> {
  const dir = join(root, SCHEMA_DUMP_DIR);
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for await (const path of new Bun.Glob('**/*.sql').scan({ cwd: dir })) {
    paths.push(path.replaceAll('\\', '/'));
  }
  paths.sort();
  const files: SchemaDumpFile[] = [];
  for (const path of paths) {
    files.push({ path, content: await Bun.file(join(dir, path)).text() });
  }
  return files;
}

export interface SchemaDumpWrite {
  /** App-root-relative paths whose bytes this call changed or created. */
  readonly written: readonly string[];
  /** Files the dump no longer produces, deleted. */
  readonly removed: readonly string[];
  /** Every file the dump holds after the write. */
  readonly total: number;
}

/**
 * Make the directory equal to `files`: write what differs, delete what nothing renders. A file
 * whose bytes already match is left untouched, so an unchanged table keeps its mtime and a
 * one-table migration is a one-file write.
 */
export async function writeSchemaDump(
  root: string,
  files: readonly SchemaDumpFile[],
): Promise<SchemaDumpWrite> {
  const dir = join(root, SCHEMA_DUMP_DIR);
  const held = new Map((await readSchemaDump(root)).map((file) => [file.path, file.content]));
  const written: string[] = [];
  for (const file of files) {
    if (held.get(file.path) === file.content) continue;
    // `createPath` is Bun's default, spelled: a kind directory may not exist yet.
    await Bun.write(join(dir, file.path), file.content, { createPath: true });
    written.push(`${SCHEMA_DUMP_DIR}/${file.path}`);
  }
  const rendered = new Set(files.map((file) => file.path));
  const removed: string[] = [];
  for (const path of held.keys()) {
    if (rendered.has(path)) continue;
    await Bun.file(join(dir, path)).delete();
    removed.push(`${SCHEMA_DUMP_DIR}/${path}`);
  }
  return { written, removed, total: files.length };
}
