// The URL the dashboard's action forms post at, derived once from the action's export name.
// A leaf on purpose: the form that renders the button (`app/admin/views.tsx`) and the action that
// answers it (`api/admin-actions.ts`) both read this, so neither can type the path a second time.

import { derivePath } from '@ultimat3/action';

/** The export name in `api/admin-actions.ts`. Renaming one without the other is a failing test. */
export const ADMIN_ACTION_NAME = 'runAdminAction';

/** `POST /api/admin-actions/run` — `derivePath` is the framework's own rule, not a guess. */
export const ADMIN_ACTION_ROUTE = derivePath(ADMIN_ACTION_NAME).path;

/**
 * Which audience answered. A browser posting the native form must land back on the screen it
 * pressed from; an agent posting JSON must get the output schema. Same operation, two audiences —
 * the split `apps/web/api/auth.ts` already makes, spelled as a pure function so it is testable
 * without a request.
 */
export const landsInBrowser = (accept: string | null): boolean =>
  (accept ?? '').includes('text/html');
