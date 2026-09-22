/**
 * The page's client scope, as a `<head>` tag: `<meta name="ultimate-scope" content="…">`, read
 * once by `@ultimat3/core`'s `pageClient()` when the page's client handle is created. Only a
 * PRIVATE document carries one (`documentCarriesScope`): anything a shared cache may hold would
 * serve one visitor's scope to the next, and a store fenced as the wrong principal is the leak the
 * fence exists to stop.
 */

import { CLIENT_PERSIST_META, CLIENT_SCOPE_META } from '@ultimat3/core';
import type { HeadTag } from './head';

/** The `name` core's reader matches — core's constant, so the writer and the reader are one literal. */
export { CLIENT_PERSIST_META, CLIENT_SCOPE_META };

/** `scope` is opaque (`@ultimat3/auth`'s `clientScopeOf`), and `''` is the anonymous page. */
export function clientScopeTag(scope: string): HeadTag {
  return {
    kind: 'meta',
    key: `meta:${CLIENT_SCOPE_META}`,
    attrs: { name: CLIENT_SCOPE_META, content: scope },
  };
}

/**
 * The record types this app keeps on disk (`entity(name, { persist: true })`), for the page's
 * persister. Beside the scope and ONLY beside it: persistence is per principal, so a document with
 * no scope has nothing to persist under. None persisted is no tag — absent already means "none".
 */
export function clientPersistTags(types: readonly string[]): readonly HeadTag[] {
  if (types.length === 0) return [];
  return [
    {
      kind: 'meta',
      key: `meta:${CLIENT_PERSIST_META}`,
      attrs: { name: CLIENT_PERSIST_META, content: [...types].sort().join(',') },
    },
  ];
}

/**
 * Whether a document with these response headers may carry a scope: its `cache-control` says
 * `private`. Read off the headers the mode ALREADY decided — `ssrHeaders` makes a gated page
 * private and an ungated one `public, s-maxage`, a stream is always private, `static`/`isr` never —
 * so this is not a second opinion on what is shareable.
 */
export function documentCarriesScope(headers: Readonly<Record<string, string>>): boolean {
  const cacheControl = headers['cache-control'] ?? '';
  return cacheControl.split(',').some((directive) => directive.trim().toLowerCase() === 'private');
}
