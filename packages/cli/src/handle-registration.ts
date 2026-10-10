// `x g entity` / `x g resource` hand the entity they wrote to the app's typed database handle. The
// generated `repo.ts` reads `db.<table>`, and a table is on the handle only when its entity is in
// the set `packages/db/src/client.ts` passes to `database()` — an edit nothing made, so the repo
// did not compile. Performed here; where the file is not the scaffold's shape, the finding names
// the two lines.

import { ERROR_DOCS_URL, stripComments } from '@ultimat3/core';
import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import type { Finding } from './output';
import { holdsKey, withKeyedLine, withSortedImport } from './source-edit';
import { closingBracket, maskOf, readList } from './source-list-edit';
import { entityModuleIn } from './templates/entity-module';
import type { GeneratedFile } from './templates/naming';
import { plural } from './templates/naming';
import type { HandleEntry } from './templates/scaffold-db-client';
import {
  dbClientSource,
  HANDLE_FILE,
  handleEntryLine,
  handleImportLine,
  PLACEHOLDER_DB_MODULE,
  webModuleOf,
} from './templates/scaffold-db-client';
import type { PlannedEdit } from './workspace-dep-edit';
import { planWorkspaceDependency, readWorkspace } from './workspace-dep-edit';

/** The two workspaces the handle joins: it lives in one and imports entities from the other. */
export const DB_WORKSPACE = 'packages/db';
const WEB_WORKSPACE = 'apps/web';
const INDEX_FILE = `${DB_WORKSPACE}/src/index.ts`;

const ENTITY_EXPORT = /\bexport const ([A-Za-z_$][\w$]*) = entity\(/;
const IDENTIFIER = '[A-Za-z_$][\\w$]*';

/** The `@<app>/db` a generated `repo.ts` imports the handle from; absent when the app names none. */
export const resolveDbModule = async (root: string): Promise<string | undefined> =>
  (await readWorkspace(root, DB_WORKSPACE))?.name;

/** The finding for an entity the handle does not serve, carrying the edit that makes it. */
export const handleUnregisteredFinding = (entry: HandleEntry, reason: string): Finding => ({
  code: 'X_DB_HANDLE_UNREGISTERED',
  cause: `${HANDLE_FILE} ${reason}, so db.${entry.key} does not exist and the generated repo.ts does not compile`,
  fix: `add ${handleImportLine(entry)} and the line "${handleEntryLine(entry).trim()}" to the entity set passed to database() in ${HANDLE_FILE}`,
  docs: ERROR_DOCS_URL,
  at: HANDLE_FILE,
});

/**
 * The object literal `database(<name>, …)` is called with: where it opens and where it closes.
 * Found on the MASKED text and closed by bracket depth — the first `}` after the `{` was the end
 * of the set, so one in a comment or in an entry's own value cut the set short.
 */
function entitySetOf(
  source: string,
): { readonly open: number; readonly close: number } | undefined {
  const masked = maskOf(source);
  const call = new RegExp(`\\bdatabase\\(\\s*(${IDENTIFIER})\\s*[,)]`).exec(masked);
  if (call === null) return undefined;
  const declared = new RegExp(`\\bconst ${call[1]}\\s*=\\s*\\{`).exec(masked);
  if (declared === null) return undefined;
  const open = declared.index + declared[0].length;
  const close = closingBracket(masked, open - 1);
  return close === -1 ? undefined : { open, close };
}

/** Whether the set opening before `open` reads back as what it held plus `line`'s entry. */
function setGained(before: string, after: string, open: number, line: string): boolean {
  const was = readList(before, maskOf(before), open - 1);
  const now = readList(after, maskOf(after), open - 1);
  if (was === undefined || now === undefined) return false;
  const expected = [...was.entries.map((entry) => entry.text), line.trim().replace(/,$/, '')];
  const held = now.entries.map((entry) => entry.text);
  return held.length === expected.length && expected.every((text) => held.includes(text));
}

/**
 * `source` with each entry imported and listed. An entry whose key the set already holds is left
 * alone; a file with no `const <set> = { … }` handed to `database()` is returned untouched with
 * every entry in `missing`.
 */
export function insertHandleEntries(
  source: string,
  entries: readonly HandleEntry[],
): { readonly source: string; readonly missing: readonly HandleEntry[] } {
  let next = source;
  const missing: HandleEntry[] = [];
  for (const entry of entries) {
    const set = entitySetOf(next);
    if (set === undefined) {
      missing.push(entry);
      continue;
    }
    const body = next.slice(set.open, set.close);
    if (holdsKey(stripComments(body), entry.key)) continue;
    const listed = withKeyedLine(body, entry.key, handleEntryLine(entry), '  ');
    const edited = `${next.slice(0, set.open)}${listed}${next.slice(set.close)}`;
    // Read back: a set this line-edit misread (a comment shaped like an entry, a value spanning
    // rows) is refused with the two lines named, never written wrong.
    if (!setGained(next, edited, set.open, handleEntryLine(entry))) {
      missing.push(entry);
      continue;
    }
    next = withSortedImport(edited, handleImportLine(entry), entry.specifier);
  }
  return { source: next, missing };
}

/** The entry an `entity.ts` implies, named by what the file exports; `undefined` for any other path. */
function entryOf(path: string, source: string, webModule: string): HandleEntry | undefined {
  const module = entityModuleIn(path, WEB_WORKSPACE);
  const binding = ENTITY_EXPORT.exec(source)?.[1];
  if (module === undefined || binding === undefined) return undefined;
  return { key: plural(binding), binding, specifier: `${webModule}/${module}` };
}

/**
 * The same registration over a file LIST, for a caller that composes generators without a disk —
 * the scaffold fixture runs every generator on top of `x new` and compiles the result, and a
 * handle that listed only the example entity would fail that compile on every other repo.
 */
export function withHandleEntries(
  files: readonly GeneratedFile[],
  dbModule: string,
): readonly GeneratedFile[] {
  const entries = files.flatMap((file) => {
    if (typeof file.contents !== 'string') return [];
    const entry = entryOf(file.path, file.contents, webModuleOf(dbModule));
    return entry === undefined ? [] : [entry];
  });
  return files.map((file) =>
    file.path === HANDLE_FILE && typeof file.contents === 'string' && file.merge === undefined
      ? { ...file, contents: insertHandleEntries(file.contents, entries).source }
      : file,
  );
}

/** The entries the written files imply: one per `entity.ts` this run put on disk. */
async function entriesFor(
  disk: GenerateDisk,
  written: readonly string[],
  webModule: string,
): Promise<readonly HandleEntry[]> {
  const entries: HandleEntry[] = [];
  for (const path of written) {
    if (entityModuleIn(path, WEB_WORKSPACE) === undefined) continue;
    const entry = entryOf(path, (await disk.read(path)) ?? '', webModule);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

export interface HandleRegistration {
  /** App-root-relative paths this rewrote or created. */
  readonly edited: readonly string[];
  readonly findings: readonly Finding[];
}

const exportsHandle = (index: string): boolean => /from\s+'\.\/client'/.test(stripComments(index));

/**
 * The db package is the app's OWN: it has an index, no handle, and exports none. A handle written
 * into it is a file nothing imports — `packages/db/src/client.ts` appeared in an app whose db
 * package is a schema and a seed, beside a finding that said the index did not export it. Said
 * instead, with what the generated repo expects, and nothing is created.
 */
const ownDbPackageFinding = (entry: HandleEntry, dbModule: string): Finding => ({
  code: 'X_DB_HANDLE_UNREGISTERED',
  cause: `${DB_WORKSPACE} has its own ${INDEX_FILE} and no typed handle (${HANDLE_FILE}), so "import { db } from '${dbModule}'" in the generated repo is not database()'s and db.${entry.key} does not exist — no handle was created in a package that does not export one`,
  // Command first, the edit behind a `#`: the line runs as printed and names what it then proves.
  fix: `x verify --only typecheck   # after rewriting the generated repo over this app's own client, or adopting the typed handle: create ${HANDLE_FILE} exporting "db = database({ ${entry.key}: ${entry.binding} }, { driver })" with ${handleImportLine(entry)} and add export { db, driver, selectDriver } from './client'; to ${INDEX_FILE}`,
  docs: ERROR_DOCS_URL,
  at: INDEX_FILE,
});

/** The handle exists but the package does not export it: the repo's import reaches something else. */
async function indexFindings(disk: GenerateDisk, dbModule: string): Promise<readonly Finding[]> {
  if (exportsHandle((await disk.read(INDEX_FILE)) ?? '')) return [];
  return [
    {
      code: 'X_DB_HANDLE_UNREGISTERED',
      cause: `${INDEX_FILE} does not export the typed handle, so "import { db } from '${dbModule}'" in the generated repo.ts is not database()'s`,
      fix: `add export { db, driver, selectDriver } from './client'; to ${INDEX_FILE} and drop db from its '@ultimat3/db' re-export`,
      docs: ERROR_DOCS_URL,
      at: INDEX_FILE,
    },
  ];
}

/**
 * Performs the registration for every entity among `written`: the handle's set and import, then
 * the manifest lines the new edges need. Creates the handle in an app that has none AND whose db
 * package would export it — an index that names `./client`, or no index at all. A db package with
 * its own index and no handle is the app's own layout: nothing is created there, and the finding
 * says what the generated repo expects.
 *
 * PLANNED, then written — all of it or none. A handle with no `const <set> = { … }` refuses the
 * entry, and a run that then went on to edit `packages/db/package.json` left a manifest line for
 * an import nobody wrote: `packages/db` depending on the app, behind a finding that said nothing
 * was registered.
 *
 * And the edge from the db package to the app is declared only for the import that needs it. The
 * handle imports each entity from the web workspace, so that edge is real exactly when the handle
 * this run leaves names that workspace; the other one — the app's `repo.ts` importing the handle —
 * is every entity's.
 */
export async function registerGeneratedEntities(
  root: string,
  written: readonly string[],
  dbModule: string | undefined,
  disk: GenerateDisk = appDisk(root),
): Promise<HandleRegistration> {
  const web = await readWorkspace(root, WEB_WORKSPACE, disk);
  const module = dbModule ?? PLACEHOLDER_DB_MODULE;
  const webModule = web?.name ?? webModuleOf(module);
  const entries = await entriesFor(disk, written, webModule);
  if (entries.length === 0) return { edited: [], findings: [] };
  const planned: PlannedEdit[] = [];
  const before = await disk.read(HANDLE_FILE);
  const index = before === undefined ? await disk.read(INDEX_FILE) : undefined;
  if (index !== undefined && !exportsHandle(index)) {
    return { edited: [], findings: entries.map((entry) => ownDbPackageFinding(entry, module)) };
  }
  const { source, missing } =
    before === undefined
      ? { source: dbClientSource(entries), missing: [] }
      : insertHandleEntries(before, entries);
  if (missing.length > 0) {
    // Refused: nothing this registrar would have written is written.
    return {
      edited: [],
      findings: missing.map((entry) =>
        handleUnregisteredFinding(entry, 'passes database() no "const <set> = { … }" to add to'),
      ),
    };
  }
  if (source !== before) planned.push({ path: HANDLE_FILE, contents: source });
  const findings: Finding[] = [];
  if (dbModule === undefined) {
    findings.push({
      code: 'X_DB_HANDLE_UNREGISTERED',
      cause: `${DB_WORKSPACE}/package.json supplies no "name", so the generated repo.ts imports the placeholder ${PLACEHOLDER_DB_MODULE}`,
      fix: `add "name": "@<app>/db" to ${DB_WORKSPACE}/package.json, then re-run this command with --force`,
      docs: ERROR_DOCS_URL,
      at: `${DB_WORKSPACE}/package.json`,
    });
  } else findings.push(...(await indexFindings(disk, dbModule)));
  const importsWeb = stripComments(source).includes(`from '${webModule}/`);
  const edges = [
    ...(importsWeb ? [[DB_WORKSPACE, WEB_WORKSPACE] as const] : []),
    [WEB_WORKSPACE, DB_WORKSPACE] as const,
  ];
  for (const [from, to] of edges) {
    const manifest = await planWorkspaceDependency(root, from, to, disk);
    if (manifest !== undefined) planned.push(manifest);
  }
  for (const edit of planned) await disk.write(edit.path, edit.contents);
  return { edited: planned.map((edit) => edit.path), findings };
}
