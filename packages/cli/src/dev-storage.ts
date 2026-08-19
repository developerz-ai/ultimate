// Single responsibility: the one HTTP surface that SERVES a stored object. `@ultimat3/storage`
// owns keys, bytes and the tenant boundary and owns no `Response`; `@ultimat3/policy` owns the
// one authz decision; this file is where those two meet a `Route` — the same shape `dev-assets.ts`
// uses for `/icons` and `/media`, so `x dev` and `apps/web/server.ts` mount one read path, not two.
//
// The base path is `@ultimat3/storage`'s `DEFAULT_SIGNED_URL_BASE`, imported and never restated:
// `localDriver` SIGNS `/_storage/<disk>/<key>`, so a local `'/_storage'` here is a second statement
// of one constant — and a signer and a reader that disagree serve 404 for every signed URL.

import { actorOf } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import type { CacheHint, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { asCtx, unauthenticated } from '@ultimat3/http';
import type { KnownPermission } from '@ultimat3/policy';
import { can, codeOf, evaluate, forbidden, reasonOf } from '@ultimat3/policy';
import type { Storage, StorageRead } from '@ultimat3/storage';
import {
  assertSafeKey,
  DEFAULT_SIGNED_URL_BASE,
  isTenantScoped,
  isWithinOrg,
  objectNotFound,
  orgMismatch,
} from '@ultimat3/storage';

/**
 * The one capability that gates reading a stored object, on every disk. A permission and not a
 * per-disk family: `disk` is in the policy's `input`, so an app that wants a per-disk rule writes
 * one predicate over it, while a second permission string would be a second thing to grant and to
 * forget. An app that declared a permission set without it gets `X_PERMISSION_UNKNOWN` from
 * `can()` — naming the exact `definePermissions` edit — rather than a request that quietly worked.
 */
export const STORAGE_READ_PERMISSION = 'storage:read';

/**
 * `can()` takes a `KnownPermission`, which narrows to the APP's declared set the moment an app
 * augments `PermissionRegistry` — and this package compiles against no app, so the bare literal is
 * a type error inside a generated project (`scaffold-typecheck` is what proves it). The check that
 * decides is the runtime one anyway: `can()` calls `assertPermission`, which throws
 * `X_PERMISSION_UNKNOWN` naming the `definePermissions` edit. `dev-hooks.ts` narrows a route's
 * structurally-typed permission for the same reason.
 */
const READ_PERMISSION = STORAGE_READ_PERMISSION as unknown as KnownPermission;

/**
 * The cache posture of a response that was authorized for ONE actor, named once so the two routes
 * that serve stored bytes cannot declare different ones — which they did: `/media` answered
 * `public, max-age=31536000, immutable` for the same object this route marks private, so a CDN held
 * one tenant's file under a public key for a year. Revalidation costs a request and no bytes, which
 * is the trade an authorized response wants: the bytes never change under a key, but the actor's
 * permission to read them can be revoked. `vary` names the two headers that carry an identity.
 */
export const AUTHORIZED_OBJECT_CACHE: CacheHint = {
  mode: 'private',
  maxAgeSeconds: 0,
  vary: ['authorization', 'cookie'],
};

/** What the rule decides about. The key IS the object's identity, so this is the whole subject. */
export interface StorageReadInput {
  readonly disk: string;
  readonly key: string;
}

/**
 * The single door. `evaluate()` is the framework's one authz entry point and this is a plain call
 * to it — no inline permission test, no per-surface args type, no "public unless configured".
 *
 * Evaluated with NO row, deliberately. An object's owner is encoded in its key (`org/<id>/<entity>/
 * <id>/<field>/…`), which `input` already carries, so a `StorageObject` would hand a predicate
 * nothing it cannot already read — and loading one first would decide "does it exist" before
 * "may you read it", which is how a caller learns another tenant's keys by watching the status.
 */
export function authorizeStorageRead(input: StorageReadInput, ctx: RequestContext): void {
  const context = asCtx(ctx);
  // Built per request, not at mount: an app whose permission set lacks `storage:read` must get a
  // problem document on this route, not a boot that takes every other route down with it.
  const policy = can<StorageReadInput>(READ_PERMISSION);
  const evaluation = evaluate(policy, { input, actor: actorOf(context) });
  if (evaluation.allowed) return;
  // The decision's own code goes on the wire, never a flattened one: `can()` denies "nobody" with
  // X_UNAUTHENTICATED and a known actor with X_FORBIDDEN, and 401 and 403 are different
  // instructions — "log in" against "you may not". `reason` is the deciding clause's own words,
  // which `@ultimat3/policy` guarantees are safe to log.
  const reason = reasonOf(evaluation.decision) ?? 'denied';
  throw codeOf(evaluation.decision) === 'X_UNAUTHENTICATED'
    ? unauthenticated(ctx.url.pathname)
    : forbidden(policy.label, reason);
}

/**
 * The key half of the read decision, in the order that discloses least: a key that could escape its
 * prefix is refused before any tenant is named, and a key inside another tenant's prefix is 404
 * (never 403 — `error-map.ts` maps `X_STORAGE_ORG_MISMATCH` there so a refusal cannot confirm that
 * a key exists).
 *
 * Split out of `readStorageObject` because `/media/*key` (`dev-assets.ts`) has to make the same
 * decision and made none at all: it passed a client-supplied key straight to `disk().get`, so every
 * object on the app's only disk was one unauthenticated URL away. A second copy of this test is how
 * one of the two surfaces would drift back — `storage-surfaces.test.ts` is what holds them level.
 */
export function assertReadableKey(key: string, actor: Actor): string {
  const safe = assertSafeKey(key);
  // An actor with no org is inside no org, so every tenant-scoped key is somebody else's. Checked
  // before `isWithinOrg`, which reads an empty org as a malformed key and would blame the caller's
  // URL for the actor's missing claim.
  const orgId = actor.orgId ?? '';
  if (isTenantScoped(safe) && (orgId === '' || !isWithinOrg(safe, orgId))) {
    throw orgMismatch(safe, orgId);
  }
  return safe;
}

/**
 * Everything between the decision and the bytes. An unknown disk is the same 404 the foreign-tenant
 * case answers, rather than `X_STORAGE_DISK_UNKNOWN`, whose cause lists every configured disk name.
 */
export async function readStorageObject(
  storage: Storage,
  input: StorageReadInput,
  actor: Actor,
): Promise<StorageRead> {
  const key = assertReadableKey(input.key, actor);
  if (!storage.diskNames.includes(input.disk)) throw objectNotFound(input.disk, key);
  return storage.disk(input.disk).get(key);
}

/** Inclusive, as `Range` and `Content-Range` both are. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const UNSATISFIABLE = 'unsatisfiable';

/**
 * One range or none. A multi-range or malformed header is ignored rather than refused — RFC 9110
 * lets a server answer the whole representation, and `multipart/byteranges` is a body format no
 * caller of this route asks for. Ranges exist here for one reason: Safari will not play a `<video>`
 * from a source that answers 200 to a `Range` probe, so an uploaded video would be a dead player.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | typeof UNSATISFIABLE | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const from = match[1] ?? '';
  const to = match[2] ?? '';
  if (from === '' && to === '') return undefined;
  if (from === '') {
    const wanted = Number(to);
    // A suffix longer than the object is the whole object, not a refusal.
    return wanted === 0 ? UNSATISFIABLE : { start: Math.max(size - wanted, 0), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start >= size || end < start ? UNSATISFIABLE : { start, end };
}

/** `*`, a weak validator and a comma list all count — the etag is what has to match. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * The content type is the STORED one — the upload gate sniffed those bytes and `put` recorded the
 * answer, so an extension in the URL is the only party that can lie. The validator is the driver's
 * own content hash (local: sha256 of the bytes, S3: the provider's etag), which is the identity
 * storage already keeps for an object; inventing a cache key here would be a second one.
 */
export function storageResponse(request: UltimateRequest, read: StorageRead): Response {
  const etag = `"${read.object.etag}"`;
  const headers = new Headers({
    'content-type': read.object.contentType,
    etag,
    'last-modified': read.object.lastModified.toUTCString(),
    'accept-ranges': 'bytes',
  });
  // Revalidation costs a request and no bytes, which is the trade an authorized response wants:
  // the bytes never change under a key, but the actor's permission to read them can be revoked.
  if (etagMatches(request.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const size = read.bytes.byteLength;
  const range = parseByteRange(request.header('range'), size);
  if (range === UNSATISFIABLE) {
    headers.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  // Copied at each call, not through a helper, for `dev-assets.ts`'s reason: a
  // `Uint8Array<ArrayBufferLike>` may be backed by a `SharedArrayBuffer`, which `Response` does
  // not accept — and a helper's declared return type widens the copy back to the type it refuses.
  if (range === undefined) {
    headers.set('content-length', String(size));
    return new Response(new Uint8Array(read.bytes), { headers });
  }
  const slice = read.bytes.subarray(range.start, range.end + 1);
  headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('content-length', String(slice.byteLength));
  return new Response(new Uint8Array(slice), { status: 206, headers });
}

export interface StorageRoutesOptions {
  /** The configured disks. The driver seam only — this route never assumes a filesystem. */
  readonly storage: Storage;
}

/**
 * `enforcedBy: 'handler'` for the reason an action route says it: the handler is the one
 * evaluation. The `authz` stage decides through `ServerHooks.authorize`, which resolves a policy
 * from `@ultimat3/render`'s page-route table — a table this route is not in, so the stage would
 * deny every request with "no policy is registered" and the real rule would never run.
 *
 * `auth: 'required'` so an anonymous caller is 401 before the handler, and `cache` is declared
 * rather than applied here: the pipeline's `cache-headers` stage is the one place a hint becomes a
 * header. `private` because the response is authorized per actor, and `vary` on the two headers
 * that carry an identity so no shared cache can hand one actor's object to another.
 */
export function storageRoutes(options: StorageRoutesOptions): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${DEFAULT_SIGNED_URL_BASE}/:disk/*key`,
      meta: {
        name: 'storage.read',
        auth: 'required',
        policy: STORAGE_READ_PERMISSION,
        enforcedBy: 'handler',
        cache: AUTHORIZED_OBJECT_CACHE,
        tags: ['storage'],
      },
      handler: async (request: UltimateRequest, ctx: RequestContext): Promise<Response> => {
        const input: StorageReadInput = {
          disk: request.params['disk'] ?? '',
          key: request.params['key'] ?? '',
        };
        authorizeStorageRead(input, ctx);
        return storageResponse(request, await readStorageObject(options.storage, input, ctx.actor));
      },
    },
  ];
}
