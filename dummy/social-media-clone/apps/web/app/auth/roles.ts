// What a signed-in member of this app may do, in ONE place. `member` is the role every seeded
// human carries (`users.role`), and `viewerActor` puts that column straight into `actor.roles` —
// so this list is the complete answer to "what does signing in get you".
//
// The grants are the permission SETS the features declared, never a hand-copied list of strings:
// a feature that declares a permission and forgets to grant it is the bug that made every page
// answer 403 to a valid session. Declare once, grant once, no second list to drift.

import { defineRoles, roleDefinitions } from '@ultimat3/policy';
import { dashboardPermissions } from '../dashboard/policy';
import { friendPermissions } from '../friends/policy';
import { messagePermissions } from '../messages/policy';
import { notificationPermissions } from '../notifications/policy';
import { postPermissions } from '../posts/policy';

/**
 * Every permission the web surface declares. Coarse on purpose: none of these is a grant on its
 * own — `post:delete`, `friend:respond` and `message:send` each carry a row-level predicate that
 * decides WHICH post, WHICH request, WHICH thread. Holding the permission is permission to be
 * asked the question, not to be answered yes.
 */
export const MEMBER_GRANTS: readonly string[] = [
  ...dashboardPermissions.all,
  ...postPermissions.all,
  ...friendPermissions.all,
  ...messagePermissions.all,
  ...notificationPermissions.all,
];

/**
 * Merged onto whatever is already defined rather than replacing it: `defineRoles()` SETS the map,
 * so this module and `apps/admin/app/admin/policy.ts` would silently delete each other's roles
 * depending on import order. Merging is the only composable spelling there is, and it is what
 * makes the two role tables independent of which file `loadApp` reaches first.
 */
export const memberRole = defineRoles({
  ...roleDefinitions(),
  member: {
    grants: [...MEMBER_GRANTS],
    description: 'a signed-in human. Every web feature, decided per row where a row exists.',
  },
});
