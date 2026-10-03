// The `policy` step's provenance question: every permission the app's OWN actions, queries and
// routes require is one the app ITSELF declares. `defineAdmin()` declares `<entity>:read|write|
// delete` for every mounted entity, so an app rule naming one passed in the web process and threw
// X_PERMISSION_UNKNOWN in any process that never mounted the admin — with nothing saying so.

// why: Bun ships no path API, and `relative` renders a frame's absolute path against the app root.
import { relative } from 'node:path';
import { listActions } from '@ultimat3/action';
import { type Policy, permissionDeclarationSites, policyPermissions } from '@ultimat3/policy';
import { listQueries } from '@ultimat3/query';
import { routeEntries } from '@ultimat3/render';
import { frameFile, siteFile } from './app-permissions-site';
import type { Finding } from './output';

/** One permission one app declaration requires. */
export interface AppRule {
  readonly permission: string;
  /** `action createPost`, `query postList`, or the route file. */
  readonly by: string;
}

/** An app rule whose permission no app module declares, and the file that did declare it. */
export interface BorrowedPermission extends AppRule {
  /**
   * Root-relative paths of EVERY declaring module (`node_modules/…` or `../…`), distinct and
   * sorted: naming only the first told the reader one package declared it when two did.
   */
  readonly from: readonly string[];
}

/**
 * EVERY permission in each tree, composites included — unlike the grant question, which judges
 * only a bare `can()`: an `or()` branch is still a `can()` that asserted its name, so it needs the
 * app's own declaration as much as a bare one does. A screen the admin MOUNTS is not here: those
 * are the package's rules, and declaring their names is the package's job.
 */
export function appRules(): readonly AppRule[] {
  const named = (by: string, policy: Policy<unknown, unknown>): readonly AppRule[] =>
    policyPermissions(policy).map((permission) => ({ permission, by }));
  return [
    ...listActions().flatMap((target) => named(`action ${target.name}`, target.policy)),
    ...listQueries().flatMap((target) => named(`query ${target.name}`, target.policy)),
    ...routeEntries().flatMap((entry) => {
      const permission = entry.config.policy?.permission;
      return permission === undefined ? [] : [{ permission, by: entry.file }];
    }),
  ];
}

/** An app module's root-relative path, or `undefined` for a dependency's or an unreadable frame. */
const appFile = (root: string, site: string): string | undefined => {
  const file = siteFile(root, site);
  return file === undefined || file.split('/').includes('node_modules') ? undefined : file;
};

/**
 * Provenance by the declaring module's PATH, which is where the call ran — never by the name's
 * shape: `posts:read` is the same string whether `defineAdmin()` or the app declared it. A name
 * with any unreadable site is one whose origin nobody can state, so it is not judged — and that
 * covers an UNKNOWN name too, which has no site at all: it is X_PERMISSION_UNKNOWN's, asked first,
 * and a second finding would be a second instruction for one fault.
 */
export function borrowedPermissions(
  root: string,
  rules: readonly AppRule[] = appRules(),
  declaredAt: Readonly<Record<string, readonly string[]>> = permissionDeclarationSites(),
): readonly BorrowedPermission[] {
  const found = new Map<string, BorrowedPermission>();
  for (const rule of rules) {
    const sites = Object.hasOwn(declaredAt, rule.permission) ? declaredAt[rule.permission] : [];
    const files = (sites ?? []).map(frameFile);
    if (files.length === 0 || files.some((file) => file === undefined)) continue;
    if ((sites ?? []).some((site) => appFile(root, site) !== undefined)) continue;
    const from = [
      ...new Set(
        files.flatMap((file) =>
          file === undefined ? [] : [relative(root, file).replaceAll('\\', '/')],
        ),
      ),
    ].sort();
    found.set(`${rule.permission}\u0000${rule.by}`, { ...rule, from });
  }
  return [...found.values()].sort((a, b) =>
    a.permission === b.permission
      ? a.by.localeCompare(b.by)
      : a.permission.localeCompare(b.permission),
  );
}

/**
 * The app file its permissions are declared in — where the missing name is added. Read off the
 * recorded sites, never a scaffold path; none under the root is `undefined`, never a guess.
 */
export function permissionsFile(root: string): string | undefined {
  for (const sites of Object.values(permissionDeclarationSites())) {
    for (const site of sites) {
      const file = appFile(root, site);
      if (file !== undefined) return file;
    }
  }
  return undefined;
}

/** A TS string literal for the name — quoted the house way unless the name itself needs escaping. */
const literal = (name: string): string =>
  /^[\w:.*-]+$/.test(name) ? `'${name}'` : JSON.stringify(name);

export function borrowedFinding(
  entry: BorrowedPermission,
  declaredIn: string | undefined,
): Finding {
  const [only, ...more] = entry.from;
  const declarers =
    more.length === 0 ? `only ${only} declares it` : `only ${entry.from.join(', ')} declare it`;
  const where =
    declaredIn === undefined
      ? 'paste this call into an app module'
      : `paste this call into ${declaredIn} (definePermissions() merges, so a second call is fine)`;
  const finding: Finding = {
    code: 'X_PERMISSION_BORROWED',
    cause:
      `${entry.by} requires ${literal(entry.permission)}, and ${declarers} — no app module does, ` +
      "so the rule holds only in a process that ran that package's declaration (defineAdmin()) " +
      `first; ${where}, then x verify --only policy`,
    // A call to paste, never prose: `add …` read as a command answered `add: command not found`.
    fix: `definePermissions([${literal(entry.permission)}])`,
  };
  return declaredIn === undefined ? finding : { ...finding, at: declaredIn };
}
