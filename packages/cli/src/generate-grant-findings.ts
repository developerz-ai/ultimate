// What `x g` could NOT grant, said out loud. `generate-grants.ts` performs the role-map edit
// where the scaffold keeps one; an app whose roles live elsewhere got no grant and no finding, and
// every generated endpoint answered 403. Apart from that module because this one only REPORTS:
// it re-asks the same pure edits of the file as it now stands and names what they could not place.

import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import type { RoleGrant } from './generate-grants';
import {
  adminGrantsFor,
  insertGrants,
  insertPermissions,
  policyGrantsFor,
  writtenTables,
} from './generate-grants';
import type { Finding } from './output';
import { ROLES_FILE } from './permission-grants';

/** Each role, and the quoted permissions its `grants` owes, in first-seen order. */
const byRoleOf = (grants: readonly RoleGrant[]): ReadonlyMap<string, readonly string[]> => {
  const byRole = new Map<string, string[]>();
  for (const grant of grants) {
    byRole.set(grant.role, [...(byRole.get(grant.role) ?? []), `'${grant.permission}'`]);
  }
  return byRole;
};

/** `member: 'run:read'; admin: 'run:write', 'runs:read'` — each role, and what its `grants` owes. */
const linesFor = (grants: readonly RoleGrant[]): string =>
  [...byRoleOf(grants)].map(([role, owed]) => `${role}: ${owed.join(', ')}`).join('; ');

/** `member: { grants: [..., 'run:read'] }` — the same, as role-map entries to merge in. */
const roleEntries = (grants: readonly RoleGrant[]): string =>
  [...byRoleOf(grants)]
    .map(([role, owed]) => `${role}: { grants: [..., ${owed.join(', ')}] }`)
    .join(', ');

/** The grants the role map as it stands still lacks: no such role, no `grants`, or undeclared. */
function stillMissing(source: string, grants: readonly RoleGrant[], admin: readonly RoleGrant[]) {
  const undeclared = insertPermissions(
    source,
    admin.map((grant) => grant.permission),
  ).skipped;
  const unplaced = insertGrants(source, grants).skipped;
  return grants.filter(
    (grant) => unplaced.includes(grant) || undeclared.includes(grant.permission),
  );
}

/**
 * One finding for everything this run declared and no role holds, or none. Asked AFTER
 * `grantGeneratedPermissions`, of the file it left: a grant it placed is not reported, and one it
 * could not place — no role map at the scaffold's path, a map with no such role, a map with no
 * `definePermissions([…])` to declare an admin permission in — is, with the role each belongs to.
 */
export async function ungrantedByGenerator(
  root: string,
  written: readonly string[],
  disk: GenerateDisk = appDisk(root),
): Promise<readonly Finding[]> {
  const admin = (await writtenTables(root, written, disk)).flatMap(adminGrantsFor);
  const grants = [...(await policyGrantsFor(root, written, disk)), ...admin];
  if (grants.length === 0) return [];
  const source = await disk.read(ROLES_FILE);
  // The file whose declarations nobody granted: where a reader starts when the map is not ours.
  const declaredIn =
    written.find((path) => path.endsWith('/policy.ts')) ?? written[0] ?? ROLES_FILE;
  if (source === undefined) {
    return [
      {
        code: 'X_PERMISSION_UNGRANTED',
        cause: `${ROLES_FILE} is not in this app, so nothing granted what this run declared — every generated endpoint answers 403 until a role holds: ${linesFor(grants)}`,
        fix: `x policy list --json   # names the module that calls defineRoles(); add to its roles' grants — ${linesFor(grants)} — then x verify --only policy`,
        at: declaredIn,
      },
    ];
  }
  const missing = stillMissing(source, grants, admin);
  if (missing.length === 0) return [];
  return [
    {
      code: 'X_PERMISSION_UNGRANTED',
      cause: `${ROLES_FILE} has no role, no "grants: [...]" list or no definePermissions([...]) these could be safely added to, so nothing granted: ${linesFor(missing)}`,
      fix: `{ ${roleEntries(missing)} }   // merge into the role map in ${ROLES_FILE}, declaring any the map does not know in definePermissions([...]) — then x verify --only policy`,
      at: ROLES_FILE,
    },
  ];
}
