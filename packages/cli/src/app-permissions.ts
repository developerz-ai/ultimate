// The gate's `policy` step: every permission this app GRANTS or REQUIRES is one it DECLARES, and
// every one it requires is one some role grants (`permission-grants.ts`).
//
// Two references in the framework are bare strings that nothing checks — `RoleDef.grants` and
// `RouteGuard.permission` — while `can()` calls `assertPermission` and throws X_PERMISSION_UNKNOWN
// the first time a request reaches the route. So a scaffolded app granted `dashboard:read`,
// required it on `/dashboard`, declared it nowhere, and served HTTP 500 on two of its three routes
// with `x verify` green (#F1). This is the question nothing asked.

import {
  grantMatches,
  isKnownPermission,
  knownPermissions,
  permissionUnknown,
  roleDeclarationSites,
  roleDefinitions,
} from '@ultimat3/policy';
import { routeEntries } from '@ultimat3/render';
import { definedStorage } from '@ultimat3/storage';
import { loadApp } from './app-load';
import { borrowedFinding, borrowedPermissions, permissionsFile } from './app-permissions-borrowed';
import { siteFile } from './app-permissions-site';
import type { DuplicateProbe } from './duplicate-packages';
import { duplicateFinding, findDuplicateInstalls } from './duplicate-packages';
import type { Finding } from './output';
import { findingFrom } from './output';
import { ungrantedFinding, ungrantedRequirements } from './permission-grants';
import { STORAGE_READ_PERMISSION } from './runtime-storage';

/** One place a permission is named by a string the framework never checks. */
export interface PermissionReference {
  readonly permission: string;
  /**
   * A role's grant, read by `grantMatches` (`<resource>:*` and `*` included), rather than a rule's
   * requirement, which `can()` asserts by exact name.
   */
  readonly grant?: true;
  /** App-root-relative POSIX path of the declaration, or `undefined` when it is not derivable. */
  readonly at: string | undefined;
  /** Who requires it when no app file does — a route the framework mounts. */
  readonly requiredBy?: string;
}

/** What this check needs of a boot — the seam `i18n-registration.ts` already established. */
export type AppLoader = (root: string) => Promise<{ readonly findings: readonly Finding[] }>;

/** Every permission a registered role grants, with where that role was declared. */
export function grantedReferences(root: string): readonly PermissionReference[] {
  const sites = roleDeclarationSites();
  return Object.entries(roleDefinitions()).flatMap(([role, definition]) =>
    definition.grants.map((permission) => ({
      permission,
      grant: true as const,
      at: Object.hasOwn(sites, role) ? siteFile(root, sites[role] ?? '') : undefined,
    })),
  );
}

/**
 * The file the role map is declared in — where a missing grant is added. Read off the declaration
 * sites `defineRoles` records, never a scaffold path: an app keeps its roles where it likes. The
 * first role with a site under the root answers; none is `undefined`, never a guess.
 */
export function roleMapFile(root: string): string | undefined {
  const sites = roleDeclarationSites();
  for (const role of Object.keys(roleDefinitions())) {
    const at = Object.hasOwn(sites, role) ? siteFile(root, sites[role] ?? '') : undefined;
    if (at !== undefined) return at;
  }
  return undefined;
}

/**
 * Every permission a registered route requires. Read off the route table rather than from source:
 * `runtime-hooks.ts` reads exactly this field to build the `can()` that runs per request, so the gate
 * and the running server cannot be looking at two different sets.
 */
export function requiredReferences(): readonly PermissionReference[] {
  const routes = routeEntries().flatMap((entry) => {
    const permission = entry.config.policy?.permission;
    return permission === undefined ? [] : [{ permission, at: entry.file }];
  });
  return [...routes, ...storageReferences()];
}

/**
 * The framework's own `GET /_storage/:disk/*key` and `/media/*key` require `storage:read`
 * (`runtime-storage.ts`), and an app whose permission set lacks it got `500 X_PERMISSION_UNKNOWN`
 * on the first signed URL it minted — at runtime, from a route it never wrote (#524). Asked only
 * of an app that declared its own disks (`defineStorage` in an app module, which is what those
 * routes then serve): one that stores nothing mints no URL, and requiring a permission it has no
 * use for would be a finding with no reader.
 */
function storageReferences(): readonly PermissionReference[] {
  return definedStorage() === undefined
    ? []
    : [
        {
          permission: STORAGE_READ_PERMISSION,
          at: undefined,
          requiredBy: 'the mounted GET /_storage/:disk/*key and /media/*key routes',
        },
      ];
}

/**
 * `isKnownPermission` and `grantMatches`, never a set membership test of this file's own: they are
 * the predicates `assertPermission` and a role's grant use, so the gate refuses exactly what the
 * running process refuses — including `isKnownPermission`'s rule
 * that an app which has declared NOTHING is not checked at all, because nothing throws there
 * either. A second predicate would be a gate that disagrees with the process it gates.
 */
const unknownOf = (references: readonly PermissionReference[]): readonly PermissionReference[] => {
  const known = knownPermissions();
  return references.filter(
    (reference) =>
      !isKnownPermission(reference.permission) &&
      // A grant is known when it covers SOME declared permission, by the matcher `can()` grants
      // through: `orgs:*` over a declared `orgs:read` is a real grant, `org:*` over nothing is a
      // typo. A requirement gets no such reading — `assertPermission` takes the exact name.
      !(reference.grant === true && known.some((name) => grantMatches(reference.permission, name))),
  );
};

/** Stable, and one finding per place — the same permission granted and required is two edits. */
const sortReferences = (
  references: readonly PermissionReference[],
): readonly PermissionReference[] => {
  const seen = new Map<string, PermissionReference>();
  for (const reference of references)
    seen.set(`${reference.permission}\u0000${reference.at}`, reference);
  return [...seen.values()].sort((a, b) =>
    a.permission === b.permission
      ? (a.at ?? '').localeCompare(b.at ?? '')
      : a.permission.localeCompare(b.permission),
  );
};

/**
 * `permissionUnknown` builds the cause and the fix, because @ultimat3/policy owns both: a second
 * wording here would be a second answer to "what do I do about an undeclared permission", and its
 * fix already leads with the nearest declared name.
 */
export function permissionFindings(root: string): readonly Finding[] {
  const references = sortReferences(
    unknownOf([...grantedReferences(root), ...requiredReferences()]),
  );
  const known = knownPermissions();
  return references.map((reference) => {
    const base = findingFrom(permissionUnknown(reference.permission, known));
    const finding =
      reference.requiredBy === undefined
        ? base
        : { ...base, cause: `${base.cause} — required by ${reference.requiredBy}` };
    return reference.at === undefined ? finding : { ...finding, at: reference.at };
  });
}

/**
 * The step's whole answer. Importing the app IS the registration — the same call `serveApp` makes
 * — so the registries this reads are the ones the server would boot with. The load's own findings
 * ride along ONLY when something is unknown, exactly as `i18n-registration.ts` carries them: a
 * module that would not import is the evidence for the gap above it and noise on a pass.
 */
export async function policyFindings(
  root: string,
  load: AppLoader = loadApp,
  duplicates: DuplicateProbe = findDuplicateInstalls,
): Promise<readonly Finding[]> {
  const app = await load(root);
  // Asked first, and asked about both registries this step's answer depends on. `isKnownPermission`
  // checks NOTHING while no permission is declared, so a second copy of `@ultimat3/policy` — the
  // app's `definePermissions` in one instance, this process reading the other — turned the step
  // green over an undeclared grant; a second `@ultimat3/entity` is the zero-entity manifest
  // `local-cli.ts` hands over for, here inside the app's own `node_modules` where it cannot.
  const duplicated = (await duplicates(root, DUPLICATE_PROBES)).map((duplicate) =>
    duplicateFinding(root, duplicate, RECHECK),
  );
  // Declared first, granted second: an undeclared permission is X_PERMISSION_UNKNOWN, and "no role
  // grants it" is only a question once the name is real.
  const unknown = permissionFindings(root);
  const rolesAt = roleMapFile(root);
  const ungranted =
    unknown.length === 0
      ? ungrantedRequirements().map((rule) => ungrantedFinding(rule, rolesAt))
      : [];
  // Asked of KNOWN names only (`borrowedPermissions` skips the rest), so it rides beside the
  // unknown half rather than behind it: one fault, one finding.
  const declaredIn = permissionsFile(root);
  const borrowed = borrowedPermissions(root).map((entry) => borrowedFinding(entry, declaredIn));
  const findings = [...duplicated, ...unknown, ...borrowed, ...ungranted];
  return findings.length === 0 ? [] : [...findings, ...app.findings];
}

/** The two registries this step's verdict is read from. */
const DUPLICATE_PROBES = ['@ultimat3/policy', '@ultimat3/entity'] as const;

/** What `X_PACKAGE_DUPLICATED`'s fix runs once the install is one copy again. */
const RECHECK = 'x verify --only policy --json';
