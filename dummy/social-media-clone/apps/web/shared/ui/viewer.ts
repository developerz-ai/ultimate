// Whether the header should render its signed-in half.
//
// `currentViewer()` is the app's one answer to "who is this", and this defers to it rather than
// re-deriving one — a second reader of `ctx.actor` is a second place the shell and a policy can
// disagree. The only thing added is the off-request case: `useContext()` throws X_NO_CONTEXT when
// there is no request at all (a build-time prerender, a unit test), and "nobody" is the right
// answer for an artifact that is then served to everyone.

import { ADMIN_READ } from '@ultimat3/admin';
import { tryUseContext } from '@ultimat3/core';
import { actorHas } from '@ultimat3/policy';
import { currentViewer, isSignedIn } from '../actor';

export const viewerIsSignedIn = (): boolean =>
  tryUseContext() !== undefined && isSignedIn(currentViewer());

/**
 * Whether to offer the admin dashboard, asked as a PERMISSION and never as a role.
 *
 * `admin:read` is the same grant `/admin`'s route gates on, expanded through the same role map, so
 * the link and the page cannot disagree — "one decision renders the button and answers the call",
 * which this app's own rules already require of the buttons INSIDE the dashboard. A role test here
 * (`isAdmin`) would be a second definition of who an operator is, and the first thing to rot when
 * a grant moves.
 */
export const viewerIsOperator = (): boolean =>
  tryUseContext() !== undefined && actorHas(currentViewer(), ADMIN_READ);
