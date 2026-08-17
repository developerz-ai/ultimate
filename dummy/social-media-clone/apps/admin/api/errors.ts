// The two refusals the dashboard's write door owns. Both are reachable from a request — a stale
// page posting a name that no longer exists, and a POST made without the button that would have
// rendered — so both carry a status: a permission denial that answers 500 tells an operator the
// server broke when the server worked exactly as designed.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';
import { registerErrorStatus } from '@ultimat3/http';

export const ADMIN_API_ERROR_CODES = {
  X_ADMIN_ACTION_UNKNOWN: { title: 'the posted action is not one this dashboard declares' },
  X_ADMIN_ACTION_REFUSED: { title: 'the admin action was refused by the decision behind it' },
} as const;

registerErrorCodes(ADMIN_API_ERROR_CODES);

// 400, not 404: the URL exists and is the right one — the `name` field in the body is wrong.
// 403, not 401: the caller IS the actor the pipeline resolved, and a 401 would send an operator
// who is already signed in back to a sign-in page.
registerErrorStatus({ X_ADMIN_ACTION_UNKNOWN: 400, X_ADMIN_ACTION_REFUSED: 403 });

export interface AdminActionUnknownInit {
  readonly name: string;
  /** Every action `defineAdmin()` registered, so the fix names the values that would have worked. */
  readonly declared: readonly string[];
}

export class AdminActionUnknownError extends UltimateError {
  constructor(init: AdminActionUnknownInit) {
    super({
      code: 'X_ADMIN_ACTION_UNKNOWN',
      cause: `"${init.name}" is not an admin action — the dashboard registered ${
        init.declared.length === 0 ? 'none' : init.declared.join(', ')
      }`,
      fix:
        init.declared.length === 0
          ? 'add the action to `actions:` in apps/admin/app/admin/admin.ts, then post its name'
          : `post name=${init.declared[0] ?? ''} instead   # or add "${init.name}" to \`actions:\` in apps/admin/app/admin/admin.ts`,
      meta: { name: init.name },
    });
  }
}

export interface AdminActionRefusedInit {
  readonly name: string;
  /** The permission that refused, off the decision — never a permission this file chose. */
  readonly permission: string;
  readonly reason: string;
  /** Set when the refusal was the destructive confirmation, not the policy. */
  readonly expectedConfirmation: string | null;
}

export class AdminActionRefusedError extends UltimateError {
  constructor(init: AdminActionRefusedInit) {
    super({
      code: 'X_ADMIN_ACTION_REFUSED',
      cause: `${init.name} was refused by ${init.permission}: ${init.reason}`,
      fix:
        init.expectedConfirmation === null
          ? `grant ${init.permission} to this actor's role in apps/admin/app/admin/policy.ts`
          : `resubmit with confirmation=${init.expectedConfirmation}`,
      meta: { name: init.name, permission: init.permission },
    });
  }
}
