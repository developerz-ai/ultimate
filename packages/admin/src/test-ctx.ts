// A `CrudCtx` for a test: an actor, the grants it holds, and an audit log to read back. A custom
// page's component is typed to need one (`AdminPageProps.ctx`), and until this existed the only
// thing that minted one was the app's whole admin — so a generated page shipped with no render
// test. Server-only, like everything in this barrel: never imported by an island.

import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';

export interface AdminTestCtxInput {
  /** Who is acting. Omitted: an actor with no role and no tenant. */
  readonly actor?: AdminActor;
  /** The permissions the actor holds. Omitted: none — every gate refuses, by name. */
  readonly granted?: readonly string[];
  readonly requestId?: string;
}

/**
 * The handle a page or a CRUD call is given, built from a grant LIST. `staticAuthz` decides it, so
 * the admin's own implications hold (`admin:write` reads) and nothing else does — a test says
 * exactly what its actor may do, and a rule that reads the row or the tenant belongs in a test
 * that builds the app's real authz.
 */
export function adminTestCtx(input: AdminTestCtxInput = {}): CrudCtx {
  return {
    actor: input.actor ?? { id: 'test-admin' },
    authz: staticAuthz(input.granted ?? []),
    audit: memoryAuditLog(),
    requestId: input.requestId ?? 'test-admin-request',
  };
}
