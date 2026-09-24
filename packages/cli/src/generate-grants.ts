// `x g policy` / `x g resource` grant what they declare. A generated `policy.ts` declares
// `<feature>:read` and `<feature>:write`; nothing granted them, so every generated endpoint
// answered 403 to every actor a role mints. The edit lands in the scaffold's one role map,
// `apps/web/shared/roles.ts`: `:read` to `member`, `:write` to `admin` (which inherits member).

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

/** Performs `insertGrants` on the app's role map. Answers the paths it rewrote. */
export async function grantGeneratedPermissions(
  root: string,
  written: readonly string[],
): Promise<readonly string[]> {
  const grants = grantsForWritten(written);
  const file = containedPath(root, ROLES_FILE);
  if (grants.length === 0 || !(await Bun.file(file).exists())) return [];
  const before = await Bun.file(file).text();
  const { source } = insertGrants(before, grants);
  if (source === before) return [];
  await Bun.write(file, source);
  return [ROLES_FILE];
}
