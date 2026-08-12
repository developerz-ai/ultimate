// Authorization for the signed-in home. One permission, no predicate: the dashboard shows the
// viewer their own summary, so "may this actor open it at all" is the whole question and there is
// no row for a rule to decide about.
//
// It has its own permission rather than borrowing `feed:read`, because the route's `policy:` line
// has to keep meaning "signed in and allowed" — and a grant that can be withdrawn from the
// dashboard alone is the only way that line is a policy rather than a route-local auth flag.
// Undeclared, it was `X_PERMISSION_UNKNOWN` at request time: a 500 on the page every sign-in
// lands on.

import { definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'dashboard:read': true;
  }
}

export const dashboardPermissions = definePermissions(['dashboard:read']);
