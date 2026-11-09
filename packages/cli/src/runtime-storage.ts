// Single responsibility: the one HTTP surface that SERVES a stored object. `@ultimat3/storage`
// owns keys, bytes and the tenant boundary and owns no `Response`; `@ultimat3/policy` owns the
// one authz decision; this file is where those two meet a `Route` — the same shape `runtime-assets.ts`
// uses for `/icons` and `/media`, so `x dev` and `apps/web/server.ts` mount one read path, not two.
//
// The base path is `@ultimat3/storage`'s `DEFAULT_SIGNED_URL_BASE`, imported and never restated:
// `localDriver` SIGNS `/_storage/<disk>/<key>`, so a local `'/_storage'` here is a second statement
// of one constant — and a signer and a reader that disagree serve 404 for every signed URL.

import type { Actor } from '@ultimat3/core';
import { actorOf } from '@ultimat3/core';
import type {
  CacheHint,
  ObjectSource,
  RequestContext,
  Route,
  UltimateRequest,
} from '@ultimat3/http';
import { asCtx, objectResponse, unauthenticated } from '@ultimat3/http';
import type { KnownPermission } from '@ultimat3/policy';
import {
  can,
  codeOf,
  evaluate,
  isKnownPermission,
  policyForbidden,
  reasonOf,
} from '@ultimat3/policy';
import type { Storage, StorageDriver } from '@ultimat3/storage';
import {
  assertSafeKey,
  DEFAULT_SIGNED_URL_BASE,
  definedStorage,
  isTenantScoped,
  isWithinOrg,
  keyUnshared,
  objectNotFound,
  orgMismatch,
  variantRevision,
  variantSourceOf,
} from '@ultimat3/storage';
import { storageUploadRoute } from './runtime-storage-upload';

/**
 * The one capability that gates reading a stored object, on every disk. A permission and not a
 * per-disk family: `disk` is in the policy's `input`, so an app that wants a per-disk rule writes
 * one predicate over it, while a second permission string would be a second thing to grant and to
 * forget. An app that declared a permission set without it serves nothing here: every read is a
 * clean 401/403 (27.0.0; it was a 500 `X_PERMISSION_UNKNOWN`).
 */
export const STORAGE_READ_PERMISSION = 'storage:read';

/**
 * `can()` takes a `KnownPermission`, which narrows to the APP's declared set the moment an app
 * augments `PermissionRegistry` — and this package compiles against no app, so the bare literal is
 * a type error inside a generated project (`scaffold-typecheck` is what proves it). The check that
 * decides is the runtime one anyway: `can()` calls `assertPermission`, which throws
 * `X_PERMISSION_UNKNOWN` naming the `definePermissions` edit. `runtime-hooks.ts` narrows a route's
 * structurally-typed permission for the same reason.
 */
const READ_PERMISSION = STORAGE_READ_PERMISSION as unknown as KnownPermission;

/**
 * The cache posture of a response that was authorized for ONE actor, named once so the two routes
 * that serve stored bytes cannot declare different ones — which they did: `/media` answered
 * `public, max-age=31536000, immutable` for the same object this route marks private, so a CDN held
 * one tenant's file under a public key for a year. A key is not content-addressed either: an
 * overwrite changes the bytes under it, which is what the etag answers. `vary` names the two
 * headers that carry an identity.
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
  const actor = actorOf(context);
  // An app that never declared `storage:read` serves nothing through this route: nobody can hold
  // an undeclared permission, so it answers what a role without the grant gets — 401 for nobody,
  // 403 for a known actor. `can()` would throw `X_PERMISSION_UNKNOWN` (500) here, and an app kept
  // the permission declared-but-ungranted only to keep its own refusal a refusal.
  if (!isKnownPermission(STORAGE_READ_PERMISSION)) {
    if (actor === null) throw unauthenticated(ctx.url.pathname);
    throw policyForbidden(
      STORAGE_READ_PERMISSION,
      `this app does not declare ${STORAGE_READ_PERMISSION}, so no role grants it`,
    );
  }
  // Built per request, not at mount: an app whose permission set lacks `storage:read` must get a
  // problem document on this route, not a boot that takes every other route down with it.
  const policy = can<StorageReadInput>(READ_PERMISSION);
  const evaluation = evaluate(policy, { input, actor });
  if (evaluation.allowed) return;
  // The decision's own code goes on the wire, never a flattened one: `can()` denies "nobody" with
  // X_UNAUTHENTICATED and a known actor with X_FORBIDDEN, and 401 and 403 are different
  // instructions — "log in" against "you may not". `reason` is the deciding clause's own words,
  // which `@ultimat3/policy` guarantees are safe to log.
  const reason = reasonOf(evaluation.decision) ?? 'denied';
  throw codeOf(evaluation.decision) === 'X_UNAUTHENTICATED'
    ? unauthenticated(ctx.url.pathname)
    : policyForbidden(policy.label, reason);
}

/**
 * The key half of the read decision, in the order that discloses least: a key that could escape its
 * prefix is refused before any tenant is named; a key inside another tenant's prefix is 404 (never
 * 403 — `error-map.ts` maps `X_STORAGE_ORG_MISMATCH` there so a refusal cannot confirm that a key
 * exists); and a key inside NO tenant's prefix is served only when the app shared it.
 *
 * That last clause is secure by default (27.0.0). The rule used to be "not another tenant's", which
 * read every key outside `org/` as everybody's: an app's all-tenant export, raw webhook payloads
 * and DSR archives were one GET away for any signed-in reader holding `storage:read`. A key no
 * tenant owns is now `X_STORAGE_KEY_UNSHARED` (404) unless `defineStorage({ shared })` lists its
 * prefix for this disk — decided from the key alone, so it too says nothing about existence.
 *
 * Split out of `readStorageObject` because `/media/*key` (`runtime-assets.ts`) has to make the same
 * decision and made none at all: it passed a client-supplied key straight to `disk().get`, so every
 * object on the app's only disk was one unauthenticated URL away. A second copy of this test is how
 * one of the two surfaces would drift back — `storage-surfaces.test.ts` is what holds them level.
 */
export function assertReadableKey(
  storage: Storage,
  disk: string,
  key: string,
  actor: Actor,
): string {
  const safe = assertSafeKey(key);
  // An actor with no org is inside no org, so every tenant-scoped key is somebody else's —
  // `isWithinOrg` answers exactly that for an empty org, without throwing.
  const orgId = actor.orgId ?? '';
  if (isTenantScoped(safe)) {
    if (!isWithinOrg(safe, orgId)) throw orgMismatch(safe, orgId);
    return safe;
  }
  if (!storage.isShared(disk, safe)) throw keyUnshared(disk, safe);
  return safe;
}

/**
 * A stored variant read by its OWN key answers for its source, or the URL outlives an erasure: a key
 * naming a revision is served only while the source still holds that revision. Both routes read
 * through here. An unrevisioned key is an ordinary object, because `logo@2x.png` is a real name.
 */
export async function assertVariantCurrent(
  driver: StorageDriver,
  disk: string,
  key: string,
): Promise<void> {
  const variant = variantSourceOf(key);
  if (variant === undefined) return;
  const source = await driver.stat(variant.source);
  if (source === undefined || variantRevision(source.etag) !== variant.revision) {
    throw objectNotFound(disk, key);
  }
}

/**
 * Everything between the decision and the bytes. An unknown disk is the same 404 the foreign-tenant
 * case answers, rather than `X_STORAGE_DISK_UNKNOWN`, whose cause lists every configured disk name.
 *
 * A STREAM of the bytes, never a buffer: `get()` holds the whole object in memory and refuses past
 * the disk's `maxGetBytes`, so a large upload was a pod's worth of heap or `X_STORAGE_TOO_LARGE`,
 * and a video's `bytes=0-` probe is the whole object, which only a stream holds. A `Range:` is
 * `streamRange`, so a seek late in the file costs its window. The content type is the STORED one and the validator the driver's own content hash: inventing a cache key here
 * would be a second identity for one object.
 */
export async function readStorageObject(
  storage: Storage,
  input: StorageReadInput,
  actor: Actor,
): Promise<ObjectSource> {
  const key = assertReadableKey(storage, input.disk, input.key, actor);
  if (!storage.diskNames.includes(input.disk)) throw objectNotFound(input.disk, key);
  const driver = storage.disk(input.disk);
  await assertVariantCurrent(driver, input.disk, key);
  const object = await driver.stat(key);
  if (object === undefined) throw objectNotFound(input.disk, key);
  // Pinned to the revision the headers are built from: an overwrite between the stat and the read
  // is `X_STORAGE_OBJECT_CHANGED`, never new bytes under the old ETag and length. An object whose
  // disk knows no etag is read unpinned — there is nothing to pin it to.
  const pin = object.etag === '' ? undefined : { etag: object.etag };
  return {
    object,
    open: async (range) =>
      range === undefined
        ? driver.stream(key, pin)
        : driver.streamRange(key, [range.start, range.end], pin),
  };
}

/**
 * The `Storage` the framework's own routes serve: the process's ONE registry when there is one —
 * the last `defineStorage()`, which is the app's whenever an app module declares its disks — and
 * the host's env-selected disk only when nothing did. Resolved per call, never captured at mount:
 * the boot builds its disk before the app's modules load, and `x dev` re-imports them on a save.
 *
 * Why not the host's disk alone (#524): an app that declared `defineStorage({ disks: { uploads,
 * evidence } })` wrote through `disk('evidence')` while `/_storage` and `/media` read the host's
 * `local`/`object`, so every URL the app's own disks signed answered 404. The app's code and the
 * framework's routes must be reading one registry, and `defineStorage` says there is only one.
 */
export function servedStorage(host: Storage): Storage {
  const current = (): Storage => definedStorage() ?? host;
  return {
    get defaultDisk(): string {
      return current().defaultDisk;
    },
    get diskNames(): readonly string[] {
      return current().diskNames;
    },
    disk: (name?: string) => current().disk(name),
    isShared: (disk: string, key: string) => current().isShared(disk, key),
  };
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
        return objectResponse(request, await readStorageObject(options.storage, input, ctx.actor));
      },
    },
    // The upload half: the `PUT` every `grantUpload` URL names (#523). One call mounts both, so
    // no route table can serve the reads of a disk it cannot write to.
    storageUploadRoute(options.storage),
  ];
}
