// A policy that admits every caller, for the tests that declare a channel whose authz is not
// their subject. Structural, never built with `@ultimat3/policy`: realtime reaches that package
// only through `@ultimat3/query`'s `guard`, and a direct import would be a second authz path.
// An app says the same thing with `allow('public')`, which is what this stands in for.

import type { QueryPolicy } from '@ultimat3/query';

export const OPEN_POLICY: QueryPolicy = Object.freeze({
  kind: 'allow',
  label: 'public',
  permissions: [],
  children: [],
  run: () => ({ allowed: true as const }),
});
