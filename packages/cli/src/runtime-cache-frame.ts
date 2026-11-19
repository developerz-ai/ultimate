// The bust frame on `x.cache.invalidate`: the wire tags, then — when the sender's bust cleared a
// shared tier — one `{ scopes }` object naming what it cleared. Every receiver since v30 keeps the
// array's strings only, so an older pod reads the tags and busts every tier, as it always did.

import type { SharedTierScopes } from '@ultimat3/cache';

/** What a receiver reads off one frame: the tags, and the sender's scopes when it named any. */
export interface BustFrame {
  readonly wire: readonly string[];
  readonly sender?: SharedTierScopes;
}

/** `CACHE_FLUSH_ALL`, parsed: a peer had more refused busts than it could keep. */
export const isFlushAll = (parsed: unknown): boolean =>
  typeof parsed === 'object' &&
  parsed !== null &&
  !Array.isArray(parsed) &&
  Reflect.get(parsed, 'flush') === 'all';

/** The payload a bust publishes. No shared tier cleared, it is the bare tag array of old. */
export function encodeBustFrame(wire: readonly string[], sender?: SharedTierScopes): string {
  if (sender === undefined || Object.keys(sender).length === 0) return JSON.stringify(wire);
  return JSON.stringify([...wire, { scopes: sender }]);
}

/**
 * A parsed frame array, read. A scopes object that is malformed in any part is read as NO scopes —
 * every tier is busted — because a skipped bust is a stale row for the whole TTL.
 */
export function decodeBustFrame(parsed: readonly unknown[]): BustFrame {
  const wire = parsed.filter((value): value is string => typeof value === 'string');
  const sender = parsed.map(scopesOf).find((scopes) => scopes !== undefined);
  return sender === undefined ? { wire } : { wire, sender };
}

function scopesOf(value: unknown): SharedTierScopes | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const scopes: unknown = Reflect.get(value, 'scopes');
  if (typeof scopes !== 'object' || scopes === null || Array.isArray(scopes)) return undefined;
  const read: Record<string, string> = {};
  for (const [name, scope] of Object.entries(scopes)) {
    if (typeof scope !== 'string') return undefined;
    read[name] = scope;
  }
  return read;
}
