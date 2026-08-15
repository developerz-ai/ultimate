// Single responsibility: object keys. Every key that reaches a driver passes through here,
// because one `..` in a user-supplied filename turns a local disk into arbitrary file write
// and an S3 disk into a cross-tenant read. Rejection is total: no sanitising, no rewriting —
// a key that needed fixing was built wrong, and silently fixing it hides the bug.

import { pathUnsafe } from './errors';

/** S3's own limit; keeping local and remote disks interchangeable requires the same ceiling. */
export const MAX_KEY_LENGTH = 1024;
export const ORG_PREFIX = 'org';

/**
 * Reserved first segment: the local driver's sidecar namespace, where an object's recorded
 * content type and etag live. Without the reservation `<root>/.meta/a/b.json` was a legal object
 * key, so an uploader could overwrite the sidecar for `a/b` and make a route serving that object
 * answer `text/html` from the app's own origin. Reserved for EVERY driver, not just the local
 * one — a key that is valid on S3 and refused on disk is two key rules.
 */
export const META_DIR = '.meta';

// `%2e%2e%2f` decodes to `../` in any layer that decodes twice (proxy, then framework).
const ENCODED_SEPARATOR = /%(?:2e|2f|5c|00)/i;

/** NUL and friends: a C-string API downstream truncates at the NUL and opens a different file. */
function hasControlByte(key: string): boolean {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function unsafeReason(key: string): string | undefined {
  if (key.length === 0) return 'is empty';
  if (key.length > MAX_KEY_LENGTH) {
    return `is ${key.length} chars, over the ${MAX_KEY_LENGTH} limit`;
  }
  if (hasControlByte(key)) return 'contains a NUL or control byte';
  if (key.includes('\\')) return 'contains a backslash';
  if (key.startsWith('/')) return 'is absolute (leading "/")';
  if (ENCODED_SEPARATOR.test(key)) return 'contains a percent-encoded separator (%2e/%2f/%5c)';
  const segments = key.split('/');
  if (segments[0] === META_DIR) return `starts with the reserved "${META_DIR}" segment`;
  for (const segment of segments) {
    if (segment.length === 0) return 'contains an empty segment ("//" or a trailing "/")';
    if (segment === '.' || segment === '..') return `contains a "${segment}" segment`;
    if (segment !== segment.trim()) return `has a padded segment ${JSON.stringify(segment)}`;
  }
  return undefined;
}

export function isSafeKey(key: string): boolean {
  return unsafeReason(key) === undefined;
}

/** Returns the key unchanged, so it composes: `Bun.file(join(root, assertSafeKey(key)))`. */
export function assertSafeKey(key: string): string {
  const reason = unsafeReason(key);
  if (reason !== undefined) throw pathUnsafe(key, reason);
  return key;
}

/**
 * Join parts into one validated key. Parts may themselves contain `/`; every resulting
 * segment is checked, so a part of `../other` fails instead of escaping.
 */
export function joinKey(...parts: readonly string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of part.split('/')) segments.push(segment);
  }
  return assertSafeKey(segments.join('/'));
}

/** An org id is exactly one segment. `a/b` would silently widen the tenant namespace. */
function assertOrgId(orgId: string): string {
  if (orgId.length === 0) throw pathUnsafe(orgId, 'is an empty org id');
  if (orgId.includes('/') || orgId.includes('\\')) {
    throw pathUnsafe(orgId, 'is an org id containing a path separator');
  }
  return orgId;
}

/** `org/<orgId>/` — the tenant boundary, present in every multi-tenant key. */
export function orgPrefix(orgId: string): string {
  return `${joinKey(ORG_PREFIX, assertOrgId(orgId))}/`;
}

/** The only blessed way to build a tenant-scoped key. */
export function scopedKey(orgId: string, ...parts: readonly string[]): string {
  return joinKey(ORG_PREFIX, assertOrgId(orgId), ...parts);
}

/** Guard for read paths: a key handed in by a client must still belong to the actor's org. */
export function isWithinOrg(key: string, orgId: string): boolean {
  return isSafeKey(key) && key.startsWith(orgPrefix(orgId));
}

/**
 * Whether the key lives in the tenant namespace at all — `scopedKey` and `grantUpload` build
 * `org/<id>/…`, `disk().put('logo.png', …)` does not. A surface serving objects has to tell the
 * two apart: `isWithinOrg` alone would answer `false` for every un-scoped key and make an app's
 * own shared assets unreachable, and dropping the check would make one tenant's prefix readable
 * by another. The pair is the question "does this key belong to somebody else?".
 */
export function isTenantScoped(key: string): boolean {
  return key.startsWith(`${ORG_PREFIX}/`);
}

/** `org/o1/a/b.png` -> `org/o1/a`. Empty for a top-level key. */
export function keyDirname(key: string): string {
  const cut = key.lastIndexOf('/');
  return cut === -1 ? '' : key.slice(0, cut);
}

/** `a/b.tar.gz` -> `.gz`. Empty when the basename has no dot. */
export function keyExtname(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}
