// `x g policy` / `x g resource` grant what they declare. A generated `policy.ts` declares
// `<feature>:read` and `<feature>:write`; nothing granted them, so every generated endpoint
// answered 403 to every actor a role mints. The edit lands in the scaffold's one role map,
// `apps/web/shared/roles.ts`: `:read` to `member`, `:write` to `admin` (which inherits member).
//
// And a generated ENTITY is a screen at `/admin/<table>`, behind `<table>:read|write|delete` —
// three permissions `defineAdmin()` derives from the table's own name. They are declared in the
// role map and granted to `admin`, or the role that runs the admin is refused its newest screen.

import { containedPath } from './generate-write';
import { ROLES_FILE } from './permission-grants';
import { wrapList } from './templates/wrap';

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

/** A generated entity file: `<surface>/<feature>/entity.ts`. */
const ENTITY_PATH = /^apps\/[^/]+\/[^/]+\/[a-z0-9-]+\/entity\.ts$/;
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

/**
 * `source` with each grant added to its role's `grants: [...]`, re-wrapped the way Biome prints
 * it. A role or a `grants` array the scaffold's shape does not have is left alone and returned in
 * `skipped` — the `policy` step's X_PERMISSION_UNGRANTED names the edit, so a guess here would be
 * a second, worse answer.
 */
export function insertGrants(
  source: string,
  grants: readonly RoleGrant[],
): { readonly source: string; readonly skipped: readonly RoleGrant[] } {
  let next = source;
  const skipped: RoleGrant[] = [];
  for (const grant of grants) {
    const role = new RegExp(`\\n  ${escapeRegExp(grant.role)}: \\{`).exec(next);
    const open = role === null ? -1 : next.indexOf('grants: [', role.index);
    const close = open === -1 ? -1 : next.indexOf(']', open);
    const blockEnd = role === null ? -1 : next.indexOf('\n  },', role.index);
    if (role === null || open === -1 || close === -1 || (blockEnd !== -1 && open > blockEnd)) {
      skipped.push(grant);
      continue;
    }
    const current = [...next.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    if (current.includes(grant.permission)) continue;
    const entries = [...current, grant.permission].map((permission) => `'${permission}'`);
    const lineStart = next.lastIndexOf('\n', open) + 1;
    const indent = next.slice(lineStart, open);
    const rewritten = wrapList(indent, 'grants: [', entries, ']').slice(indent.length);
    next = `${next.slice(0, open)}${rewritten}${next.slice(close + 1)}`;
  }
  return { source: next, skipped };
}

const DECLARATION = 'definePermissions([';

/**
 * `source` with each permission added to its first `definePermissions([…])`, re-wrapped the way
 * Biome prints it. Declared BEFORE it is granted: `can()` refuses a name no call registered, and
 * `defineRoles()` does not — a grant nothing declares is a 500 on the first request that asks.
 * A role map with no such call is left alone and every permission returned in `skipped`.
 */
export function insertPermissions(
  source: string,
  permissions: readonly string[],
): { readonly source: string; readonly skipped: readonly string[] } {
  const open = source.indexOf(DECLARATION);
  const close = open === -1 ? -1 : source.indexOf('])', open);
  if (open === -1 || close === -1) return { source, skipped: [...permissions] };
  const current = [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  const added = permissions.filter((permission) => !current.includes(permission));
  if (added.length === 0) return { source, skipped: [] };
  const lineStart = source.lastIndexOf('\n', open) + 1;
  const head = source.slice(lineStart, open);
  const tail = source.slice(close + 2, source.indexOf('\n', close));
  const entries = [...current, ...added].map((permission) => `'${permission}'`);
  const rewritten = wrapList('', `${head}${DECLARATION}`, entries, `])${tail}`);
  return {
    source: `${source.slice(0, lineStart)}${rewritten}${source.slice(source.indexOf('\n', close))}`,
    skipped: [],
  };
}

/** The entity names the written `entity.ts` files declare — read off each file, never guessed. */
export async function writtenTables(
  root: string,
  written: readonly string[],
): Promise<readonly string[]> {
  const tables: string[] = [];
  for (const path of written.filter((candidate) => ENTITY_PATH.test(candidate))) {
    const table = ENTITY_NAME.exec(await Bun.file(containedPath(root, path)).text())?.[1];
    if (table !== undefined) tables.push(table);
  }
  return tables;
}

/**
 * Performs both edits on the app's role map: a written policy's grants, and — for each written
 * entity — the admin's three permissions for its table, declared and granted. Answers the paths
 * it rewrote.
 */
export async function grantGeneratedPermissions(
  root: string,
  written: readonly string[],
): Promise<readonly string[]> {
  const admin = (await writtenTables(root, written)).flatMap(adminGrantsFor);
  const grants = [...grantsForWritten(written), ...admin];
  const file = containedPath(root, ROLES_FILE);
  if (grants.length === 0 || !(await Bun.file(file).exists())) return [];
  const before = await Bun.file(file).text();
  const declared = insertPermissions(
    before,
    admin.map((grant) => grant.permission),
  );
  // Granted only where it could be declared: a grant with no declaration is the 500 above.
  const grantable = grants.filter((grant) => !declared.skipped.includes(grant.permission));
  const { source } = insertGrants(declared.source, grantable);
  if (source === before) return [];
  await Bun.write(file, source);
  return [ROLES_FILE];
}
