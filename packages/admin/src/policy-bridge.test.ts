// The one global-state property `policy-bridge.ts` rests on: its module-scope
// `definePermissions(ADMIN_PERMISSIONS)` ADDS admin's four names to the process-global permission
// registry and never replaces what an app declared. Both tracked apps depend on it in both
// directions — `dummy/social-media-clone/apps/admin/app/admin/policy.ts` declares its own set on
// top of this one and says so in a comment.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  clearPermissions,
  definePermissions,
  knownPermissions,
  type Permission,
} from '@ultimat3/policy';
import { ADMIN_PERMISSIONS } from './permissions';

let ambientPermissions: readonly string[] = [];

// Importing this package is itself a mutation of the registry, so this file hands the process back
// exactly the set it found — otherwise it becomes the next file's ordering bug.
beforeAll(() => {
  ambientPermissions = knownPermissions();
});

afterAll(() => {
  clearPermissions();
  // Every member arrived through a `definePermissions` call, so it is a `resource:verb` already.
  if (ambientPermissions.length > 0) definePermissions(ambientPermissions as readonly Permission[]);
});

describe('the module-scope permission registration', () => {
  // Imported dynamically, inside the test: a static import would register admin's four names in
  // every process that merely loads this file, which is the hazard being pinned.
  test('registering by import alone is what lets an app never declare admin:*', async () => {
    const { adminPermissions } = await import('./policy-bridge');

    expect(adminPermissions.all).toEqual([...ADMIN_PERMISSIONS]);
    for (const permission of ADMIN_PERMISSIONS) {
      expect(knownPermissions()).toContain(permission);
    }
  });

  test("an app's own set survives it — declaration adds, it never replaces", async () => {
    definePermissions(['post:read', 'post:publish']);
    await import('./policy-bridge');

    // If `definePermissions` ever replaced instead of merging, one of these two sets would be gone
    // and every `can()` in the losing half would throw X_PERMISSION_UNKNOWN at declaration time —
    // in a shipped app, not just in a test. Order cannot matter precisely because it only adds.
    expect(knownPermissions()).toEqual(
      expect.arrayContaining(['post:read', 'post:publish', ...ADMIN_PERMISSIONS]),
    );
  });
});
