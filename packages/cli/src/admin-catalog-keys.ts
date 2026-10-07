// The catalog keys a MOUNTED admin renders: asked of each `AdminApp` (`catalogKeys()`), never
// walked here — the admin owns the one derivation, so a key `defineAdmin` would draw and the
// `i18n` step audits can never be two spellings of one rule.

import { describePages } from '@ultimat3/render';

/**
 * The keys of every admin this process declared. Asked of the route table first: an app with no
 * admin never loads `@ultimat3/admin` (axiom 6), and one that has one has loaded it already, so
 * the dynamic import below is a cache hit.
 */
export async function mountedAdminKeys(): Promise<readonly string[]> {
  if (!describePages().some((route) => route.mount?.by === 'defineAdmin')) return [];
  const { adminMounts } = await import('@ultimat3/admin');
  return [...new Set(adminMounts().flatMap((app) => app.catalogKeys()))].sort();
}
