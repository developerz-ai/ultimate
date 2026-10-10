// `x g policy` / `x g resource` grant what they declare. A generated `policy.ts` declares
// `<feature>:read` and `<feature>:write`; nothing granted them, so every generated endpoint
// answered 403 to every actor a role mints. The edit lands in the scaffold's one role map,
// `apps/web/shared/roles.ts`: `:read` to `member`, `:write` to `admin` (which inherits member).
//
// And a generated ENTITY is a screen at `/admin/<table>`, behind `<table>:read|write|delete` —
// three permissions `defineAdmin()` derives from the table's own name. They are declared in the
// role map and granted to `admin`, or the role that runs the admin is refused its newest screen.

import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import { ROLES_FILE } from './permission-grants';
import { absentFrom, appendToList, maskOf, readList, readProperties } from './source-list-edit';
import { isEntityModule } from './templates/entity-module';

/** One permission to add to one role's `grants`. */
export interface RoleGrant {
  readonly role: string;
  readonly permission: string;
}

/** A generated policy file: `<surface>/<feature>/policy.ts`, never a test beside it. */
const POLICY_PATH = /^apps\/[^/]+\/[^/]+\/(?<feature>[a-z0-9-]+)\/policy\.ts$/;

/**
 * The grants a written file set implies: the lowest role that makes sense for each verb. `member`
 * reads, `admin` writes — the scaffold's dev actor is `admin`, so both reach it through
 * `inherits`, and a `member` cookie still cannot write.
 */
export function grantsForWritten(written: readonly string[]): readonly RoleGrant[] {
  return written.flatMap((path) => {
    const feature = POLICY_PATH.exec(path)?.groups?.['feature'];
    return feature === undefined
      ? []
      : [
          { role: 'member', permission: `${feature}:read` },
          { role: 'admin', permission: `${feature}:write` },
        ];
  });
}

/** `entity('widgets', {` — the name the admin's permissions are spelled with. */
const ENTITY_NAME = /\bentity\(\s*'([^']+)'/;

/**
 * What the admin asks for one table, granted to the role that runs it. The verbs are
 * `@ultimat3/admin`'s `entityPermissionFor` — `read` to list, open and search, `write` to create
 * and edit, `delete` to delete — and the resource is the ENTITY's name, never the feature's.
 */
export function adminGrantsFor(table: string): readonly RoleGrant[] {
  return ['read', 'write', 'delete'].map((verb) => ({
    role: 'admin',
    permission: `${table}:${verb}`,
  }));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const quoted = (permission: string): string => `'${permission}'`;

/**
 * Where the object of role `name` opens: a property of the `defineRoles({ … })` call, or — in a
 * map handed to it by name — the scaffold's own `  <role>: {` row. Read off the masked text, so a
 * role named in a comment or a string is prose and never the one edited.
 */
function roleObject(source: string, masked: string, name: string): number | undefined {
  const call = /\bdefineRoles\(\s*\{/.exec(masked);
  if (call !== null) {
    const role = readProperties(source, masked, call.index + call[0].length - 1).find(
      (property) => property.key === name,
    );
    return role !== undefined && masked[role.value] === '{' ? role.value : undefined;
  }
  const row = new RegExp(`\\n  ${escapeRegExp(name)}: \\{`).exec(masked);
  return row === null ? undefined : row.index + row[0].length - 1;
}

/**
 * `source` with each grant added to its role's `grants: [...]`. A list on one line is re-wrapped
 * the way Biome prints it; a list over several lines gains a row and keeps every comment it holds.
 * A role or a `grants` array the map does not have — or one that cannot be edited safely — is left
 * alone and returned in `skipped`: the finding names the edit, so a guess here would be a second,
 * worse answer.
 */
export function insertGrants(
  source: string,
  grants: readonly RoleGrant[],
): { readonly source: string; readonly skipped: readonly RoleGrant[] } {
  let next = source;
  const skipped: RoleGrant[] = [];
  for (const grant of grants) {
    const masked = maskOf(next);
    const role = roleObject(next, masked, grant.role);
    const list =
      role === undefined
        ? undefined
        : readProperties(next, masked, role).find((property) => property.key === 'grants');
    const edited =
      list === undefined || masked[list.value] !== '['
        ? undefined
        : appendToList(next, list.value, [quoted(grant.permission)]);
    if (edited === undefined) skipped.push(grant);
    else next = edited;
  }
  return { source: next, skipped };
}

/** Every `definePermissions([` in the masked text: the index of each call's opening `[`. */
const declarationLists = (masked: string): readonly number[] =>
  [...masked.matchAll(/\bdefinePermissions\(\s*\[/g)].map(
    (found) => found.index + found[0].length - 1,
  );

/**
 * `source` with each permission added to its first `definePermissions([…])`. Declared BEFORE it is
 * granted: `can()` refuses a name no call registered, and `defineRoles()` does not — a grant
 * nothing declares is a 500 on the first request that asks. One ANY call already declares is left
 * alone. A role map with no such call, or one that cannot be edited safely, is left alone and
 * every permission returned in `skipped`.
 */
export function insertPermissions(
  source: string,
  permissions: readonly string[],
): { readonly source: string; readonly skipped: readonly string[] } {
  const masked = maskOf(source);
  const lists = declarationLists(masked).flatMap((open) => readList(source, masked, open) ?? []);
  const first = lists[0];
  if (first === undefined) return { source, skipped: [...permissions] };
  const added = lists.reduce<readonly string[]>(
    (absent, list) => absentFrom(list, absent),
    permissions.map(quoted),
  );
  if (added.length === 0) return { source, skipped: [] };
  const edited = appendToList(source, first.open, added);
  return edited === undefined
    ? { source, skipped: [...permissions] }
    : { source: edited, skipped: [] };
}

/** The entity names the written entity files declare — read off each file, never guessed. */
export async function writtenTables(
  root: string,
  written: readonly string[],
  disk: GenerateDisk = appDisk(root),
): Promise<readonly string[]> {
  const tables: string[] = [];
  for (const path of written.filter(isEntityModule)) {
    const table = ENTITY_NAME.exec((await disk.read(path)) ?? '')?.[1];
    if (table !== undefined) tables.push(table);
  }
  return tables;
}

/**
 * Performs both edits on the app's role map: a written policy's grants, and — for each written
 * entity — the admin's three permissions for its table, declared and granted. Answers the paths
 * it rewrote.
 *
 * A permission is declared only where its grant can be placed. An app with no `admin` role got
 * three permissions declared that no role held — `X_PERMISSION_UNGRANTED` on the next gate, for
 * names the author never asked for — beside the finding that said nothing was granted.
 */
export async function grantGeneratedPermissions(
  root: string,
  written: readonly string[],
  disk: GenerateDisk = appDisk(root),
): Promise<readonly string[]> {
  const admin = (await writtenTables(root, written, disk)).flatMap(adminGrantsFor);
  const grants = [...grantsForWritten(written), ...admin];
  const before = grants.length === 0 ? undefined : await disk.read(ROLES_FILE);
  if (before === undefined) return [];
  const unplaced = insertGrants(before, grants).skipped;
  const placeable = grants.filter((grant) => !unplaced.includes(grant));
  const declared = insertPermissions(
    before,
    admin.filter((grant) => placeable.includes(grant)).map((grant) => grant.permission),
  );
  // Granted only where it could be declared: a grant with no declaration is the 500 above.
  const grantable = placeable.filter((grant) => !declared.skipped.includes(grant.permission));
  const { source } = insertGrants(declared.source, grantable);
  if (source === before) return [];
  await disk.write(ROLES_FILE, source);
  return [ROLES_FILE];
}
