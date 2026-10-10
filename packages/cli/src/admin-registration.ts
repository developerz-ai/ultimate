// `x g resource --admin` wires the override it wrote. The entity is already an admin screen — it
// is in the handle `defineAdmin({ entities: adminEntitiesOf(db) })` reads — so the override file is
// the ONLY thing `--admin` adds, and an override nothing lists under `resources:` is a dead file.
// Performed here; where the admin is not a `defineAdmin({ … })` this can add to, the finding names
// the two lines.

import { ERROR_DOCS_URL, maskLiterals, stripComments } from '@ultimat3/core';
import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import type { Finding } from './output';
import { holdsKey, withKeyedLine, withSortedImport } from './source-edit';
import type { GeneratedFile } from './templates/naming';
import { declareWorkspaceDependency, readWorkspace } from './workspace-dep-edit';

/** The scaffold's one admin declaration. */
export const ADMIN_FILE = 'apps/admin/app/admin/admin.ts';
const ADMIN_WORKSPACE = 'apps/admin';
const WEB_WORKSPACE = 'apps/web';

const OVERRIDE_PATH = /^apps\/web\/(?<rest>[^/]+\/[^/]+)\/admin\/resource\.ts$/;
const OVERRIDE_EXPORT = /\bexport const ([A-Za-z_$][\w$]*AdminResource)\b/;
const ENTITY_NAME = /\bentity\(\s*'([^']+)'/;

/** One override to list: `resources: { <table>: <binding> }`. */
export interface AdminResourceEntry {
  /** The entity's own name — the key `defineAdmin` resolves an override by. */
  readonly table: string;
  /** The override's exported binding: `widgetAdminResource`. */
  readonly binding: string;
  readonly specifier: string;
}

const importLine = (entry: AdminResourceEntry): string =>
  `import { ${entry.binding} } from '${entry.specifier}';`;

const resourceLine = (entry: AdminResourceEntry): string => `    ${entry.table}: ${entry.binding},`;

export const adminResourceUnwiredFinding = (
  entry: AdminResourceEntry,
  reason: string,
): Finding => ({
  code: 'X_ADMIN_RESOURCE_UNWIRED',
  cause: `${ADMIN_FILE} ${reason}, so the override ${entry.binding} is read by nothing and /admin/${entry.table} keeps its derived defaults`,
  fix: `add ${importLine(entry)} and "resources: { ${entry.table}: ${entry.binding} }" to the defineAdmin() call in ${ADMIN_FILE}`,
  docs: ERROR_DOCS_URL,
  at: ADMIN_FILE,
});

/** Past the brace that closes the one opening at `open`, read off comment-masked text. */
function closeOf(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * `source` with each override imported and listed under `resources:`, which is created — last in
 * the call — when the declaration has none. Positions are found on the comment-masked text: the
 * scaffold's own comment says `resources: { <entity>: … }`, and that is prose, not the key.
 */
export function insertAdminResources(
  source: string,
  entries: readonly AdminResourceEntry[],
): { readonly source: string; readonly missing: readonly AdminResourceEntry[] } {
  let next = source;
  const missing: AdminResourceEntry[] = [];
  for (const entry of entries) {
    // Literals masked too: a brace inside a string label is not one of the call's.
    const masked = maskLiterals(next);
    const call = /\bdefineAdmin\(\s*\{/.exec(masked);
    const open = call === null ? -1 : call.index + call[0].length - 1;
    const close = open === -1 ? -1 : closeOf(masked, open);
    if (open === -1 || close === -1) {
      missing.push(entry);
      continue;
    }
    const key = /\n[ \t]*resources:\s*\{/.exec(masked.slice(open, close));
    if (key === null) {
      // On its own rows before the call's closing brace, after whatever the author wrote last.
      const at = next.lastIndexOf('\n', close) + 1;
      const block = `  resources: {\n${resourceLine(entry)}\n  },\n`;
      next = `${next.slice(0, at)}${block}${next.slice(at)}`;
    } else {
      const bodyOpen = open + key.index + key[0].length;
      const bodyClose = closeOf(masked, bodyOpen - 1);
      const body = next.slice(bodyOpen, bodyClose);
      if (holdsKey(stripComments(body), entry.table)) continue;
      const listed = withKeyedLine(body, entry.table, resourceLine(entry), '    ');
      next = `${next.slice(0, bodyOpen)}${listed}${next.slice(bodyClose)}`;
    }
    next = withSortedImport(next, importLine(entry), entry.specifier);
  }
  return { source: next, missing };
}

/** The entry an override file implies, given the source of the entity beside it. */
function entryOf(
  path: string,
  override: string,
  entity: string | undefined,
  webModule: string,
): AdminResourceEntry | undefined {
  const rest = OVERRIDE_PATH.exec(path)?.groups?.['rest'];
  const binding = OVERRIDE_EXPORT.exec(override)?.[1];
  const table = entity === undefined ? undefined : ENTITY_NAME.exec(entity)?.[1];
  if (rest === undefined || binding === undefined || table === undefined) return undefined;
  return { table, binding, specifier: `${webModule}/${rest}/admin/resource` };
}

const entityPathOf = (overridePath: string): string =>
  overridePath.replace(/\/admin\/resource\.ts$/, '/entity.ts');

/**
 * The same wiring over a file LIST, for a caller that composes generators without a disk — the
 * scaffold fixture compiles the result, which is what proves the override's type fits `resources:`.
 */
export function withAdminResources(
  files: readonly GeneratedFile[],
  webModule: string,
): readonly GeneratedFile[] {
  const text = new Map(
    files.flatMap((file) =>
      typeof file.contents === 'string' ? [[file.path, file.contents] as const] : [],
    ),
  );
  const entries = [...text].flatMap(([path, contents]) => {
    const entry = entryOf(path, contents, text.get(entityPathOf(path)), webModule);
    return entry === undefined ? [] : [entry];
  });
  return files.map((file) =>
    file.path === ADMIN_FILE && typeof file.contents === 'string' && file.merge === undefined
      ? { ...file, contents: insertAdminResources(file.contents, entries).source }
      : file,
  );
}

/** The overrides among the written paths, each named by what its file and its entity export. */
async function entriesFor(
  disk: GenerateDisk,
  written: readonly string[],
  webModule: string,
): Promise<readonly AdminResourceEntry[]> {
  const entries: AdminResourceEntry[] = [];
  for (const path of written) {
    if (!OVERRIDE_PATH.test(path)) continue;
    const entry = entryOf(
      path,
      (await disk.read(path)) ?? '',
      await disk.read(entityPathOf(path)),
      webModule,
    );
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

export interface AdminRegistration {
  /** App-root-relative paths this rewrote. */
  readonly edited: readonly string[];
  readonly findings: readonly Finding[];
}

/** Performs `insertAdminResources` on the app's admin, and declares the edge the import is. */
export async function registerAdminResources(
  root: string,
  written: readonly string[],
  disk: GenerateDisk = appDisk(root),
): Promise<AdminRegistration> {
  const web = await readWorkspace(root, WEB_WORKSPACE, disk);
  const entries = web === undefined ? [] : await entriesFor(disk, written, web.name);
  if (entries.length === 0) return { edited: [], findings: [] };
  const before = await disk.read(ADMIN_FILE);
  if (before === undefined) {
    return {
      edited: [],
      findings: entries.map((entry) => adminResourceUnwiredFinding(entry, 'does not exist')),
    };
  }
  const { source, missing } = insertAdminResources(before, entries);
  const findings = missing.map((entry) =>
    adminResourceUnwiredFinding(entry, 'holds no defineAdmin({ … }) call to add to'),
  );
  if (source === before) return { edited: [], findings };
  await disk.write(ADMIN_FILE, source);
  const manifest = await declareWorkspaceDependency(root, ADMIN_WORKSPACE, WEB_WORKSPACE, disk);
  return { edited: manifest === undefined ? [ADMIN_FILE] : [ADMIN_FILE, manifest], findings };
}
