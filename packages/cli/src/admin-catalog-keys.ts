// The catalog keys a MOUNTED admin renders: asked of each `AdminApp` (`catalogKeys()`), never
// walked here — the admin owns the one derivation, so a key `defineAdmin` would draw and the
// `i18n` step audits can never be two spellings of one rule. Also the label `x i18n sync` writes
// for one, by the rule `x g resource --admin` already labels its own keys with.

import { describePages } from '@ultimat3/render';
import { columnLabel } from './templates/admin-catalog';

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

/** Segments that name the slot a string fills, not the thing it labels: `admin.posts.title`. */
const SLOT_SEGMENTS = new Set(['title', 'label']);

/**
 * `admin.posts.field.createdAt` → `Created at`, `admin.posts.title` → `Posts`: the label the
 * generator writes for a key it derives (`adminCatalogEntries`), read back off the key itself so a
 * key the generator never wrote — a section, a scope, an action — gets the same treatment.
 */
export function adminKeyLabel(key: string): string {
  const segments = key.split('.');
  while (segments.length > 1 && SLOT_SEGMENTS.has(segments.at(-1) ?? '')) segments.pop();
  return columnLabel(segments.at(-1) ?? key);
}
