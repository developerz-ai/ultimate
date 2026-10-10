// The role map of an app that documents it: comments between the permissions, apostrophes in the
// comments, two `definePermissions([…])` calls and roles of its own. `x g entity blog-post` took
// every apostrophe for a string delimiter — "the firm's", "the caller's" — and rewrote the
// comments between two of them into permissions, in a file the gate then could not load. The
// fixture is that shape; `source-list-edit.test.ts` is the general proof.

import { describe, expect, test } from 'bun:test';
import { adminGrantsFor, insertGrants, insertPermissions } from './generate-grants';

const ROLE_MAP = `// Who holds which permission. A permission no role holds is one no actor can exercise, and
// \`x verify\`'s policy step refuses it — \`grants: ['never:this']\` here is prose.

import { definePermissions, defineRoles } from '@ultimat3/policy';

/** What a customer org's members may do. */
export const customerPermissions = definePermissions([
  'dashboard:read',
  // Lawyers hold it only once KYC is approved — a predicate reading the actor fact, never a
  // second grant here: \`actorFact(actor, 'kycApproved')\`.
  'notification:send',
  // plan 103/05: read the org's invoices and credit notes.
  'invoicing:read',
  // plan 106/04: list, issue and revoke the org's tokens — lawyers and owners; a token never
  // outranks its holder's current role.
  'api-access:read',
  // plan 104/02: every member reads the firm's terms [see the matrix]; owners can't skip it.
  'deadline:read',
]);

/** The staff rows. A row is added only with the primitive that needs it. */
export const staffPermissions = definePermissions([
  'admin:read',
  // The console's own write gate — the operator's, not the firm's.
  'admin:write',
]);

export const appPermissions = definePermissions([
  ...customerPermissions.all,
  ...staffPermissions.all,
]);

export const roles = defineRoles({
  // Customer roles. A viewer's grants aren't inherited by anybody below.
  viewer: {
    description: "Reads the firm's cases; can't send.",
    grants: [
      'dashboard:read',
      // every member reads the firm's terms
      'deadline:read',
    ],
  },
  owner: {
    description: 'Owns the org.',
    grants: ['invoicing:read', 'api-access:read'],
    inherits: ['viewer'],
  },
  // Staff. The superadmin's grants are the union — it isn't a bypass.
  admin: {
    description: \`Staff: the console's operator.\`,
    grants: [
      'admin:read', // to look
      'admin:write' // to change — the operator's own
    ],
  },
});
`;

/** Every comment and template literal, in order. */
const proseOf = (source: string): readonly string[] =>
  source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`/g) ?? [];

const PERMISSIONS = ['blog_posts:read', 'blog_posts:write', 'blog_posts:delete'];

describe('unit · a commented role map is edited without touching a comment', () => {
  test('the three admin permissions are declared after the last entry, and nothing else moves', () => {
    const { source, skipped } = insertPermissions(ROLE_MAP, PERMISSIONS);
    expect(skipped).toEqual([]);
    expect(proseOf(source)).toEqual(proseOf(ROLE_MAP));
    // Exactly three rows were added, and removing them is the original file.
    const rows = "  'blog_posts:read',\n  'blog_posts:write',\n  'blog_posts:delete',\n";
    expect(source).toContain(`  'deadline:read',\n${rows}]);`);
    expect(source.replace(rows, '')).toBe(ROLE_MAP);
  });

  test('they are granted to admin: the comment beside its last grant stays beside it', () => {
    const declared = insertPermissions(ROLE_MAP, PERMISSIONS).source;
    const { source, skipped } = insertGrants(declared, adminGrantsFor('blog_posts'));
    expect(skipped).toEqual([]);
    expect(proseOf(source)).toEqual(proseOf(ROLE_MAP));
    expect(source).toContain(
      "      'admin:write', // to change — the operator's own\n      'blog_posts:read',\n      'blog_posts:write',\n      'blog_posts:delete',\n    ],",
    );
    // No customer role gained anything, and no other list changed.
    expect(source).toContain("grants: ['invoicing:read', 'api-access:read'],");
    expect(source).toContain("      'deadline:read',\n    ],\n  },\n  owner:");
  });

  test('a second run declares and grants nothing twice', () => {
    const once = insertGrants(
      insertPermissions(ROLE_MAP, PERMISSIONS).source,
      adminGrantsFor('blog_posts'),
    ).source;
    expect(insertPermissions(once, PERMISSIONS).source).toBe(once);
    expect(insertGrants(once, adminGrantsFor('blog_posts')).source).toBe(once);
  });

  test('a permission ANY definePermissions() call declares is not declared again in the first', () => {
    const { source, skipped } = insertPermissions(ROLE_MAP, ['admin:write', 'deadline:read']);
    expect(skipped).toEqual([]);
    expect(source).toBe(ROLE_MAP);
  });

  test('a role named only in a comment or a string is not a role: skipped, file untouched', () => {
    const noAdmin = ROLE_MAP.slice(0, ROLE_MAP.indexOf('  // Staff.')).concat(
      "  // admin: { grants: ['x:read'] } is what it'd look like\n});\n",
    );
    const { source, skipped } = insertGrants(noAdmin, adminGrantsFor('blog_posts'));
    expect(skipped).toEqual(adminGrantsFor('blog_posts'));
    expect(source).toBe(noAdmin);
  });

  test('a grants list that is not an array literal is skipped, never rewritten', () => {
    const spread = ROLE_MAP.replace(
      "grants: ['invoicing:read', 'api-access:read'],",
      'grants: OWNER_GRANTS,',
    );
    const { source, skipped } = insertGrants(spread, [{ role: 'owner', permission: 'blog:write' }]);
    expect(skipped).toEqual([{ role: 'owner', permission: 'blog:write' }]);
    expect(source).toBe(spread);
  });
});
