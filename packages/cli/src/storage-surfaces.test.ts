// Two routes reach the same stored bytes — `GET /media/*key` (`dev-assets.ts`) and
// `GET /_storage/:disk/*key` (`dev-storage.ts`) — and every test in this repo drove one surface at
// a time, which is exactly why `/media` shipped `auth: 'public'` with no policy and no tenant check
// while its twin required both. These cases compare the two AGAINST EACH OTHER: one object, one
// actor, both routes, one verdict.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// `node:` by necessity: Bun has no temp-directory helper, and a shared root would let one case's
// object decide the next case's answer.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '@ultimat3/core';
import {
  anonymousActor,
  createRaster,
  encodeImage,
  UltimateError,
  userActor,
} from '@ultimat3/core';
import type { CacheHint, RequestContext, Route } from '@ultimat3/http';
import {
  cacheControl,
  createRequestContext,
  defineHttpConfig,
  UltimateRequest,
} from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver, resetStorage, scopedKey, variantKey } from '@ultimat3/storage';
import { assetRoutes, MEDIA_BASE_PATH } from './dev-assets';
import {
  AUTHORIZED_OBJECT_CACHE,
  STORAGE_BASE_PATH,
  STORAGE_READ_PERMISSION,
  storageRoutes,
} from './dev-storage';

/** A real PNG, because the `?w=` cases below decode it rather than refusing it as a bad image. */
const BYTES = encodeImage(createRaster(64, 64, 'tenant-a-private'), 'png');
const SCOPED_KEY = scopedKey('org-a', 'private', 'secret.png');
const UNSCOPED_KEY = 'brand/logo.png';

let root = '';
let storage: Storage;

/**
 * What a surface answered, reduced to the two things both surfaces must agree on. A thrown
 * `UltimateError` and a status are the same kind of answer here — `@ultimat3/http`'s `error-map`
 * turns one into the other — so the verdict is the code, never the shape of the failure.
 */
type Verdict =
  | { readonly kind: 'served'; readonly cacheControl: string }
  | { readonly kind: 'refused'; readonly code: string };

async function verdictOf(
  answer: () => Promise<Response>,
  declared: CacheHint | undefined,
): Promise<Verdict> {
  try {
    const response = await answer();
    // What a client actually receives, computed the way `@ultimat3/http`'s `cache-headers` stage
    // computes it: the header a handler set, else the route's declaration. One surface declares
    // and the other applies, so comparing raw headers would report a difference the wire has not.
    const header = response.headers.get('cache-control');
    const effective = header ?? (declared === undefined ? '' : cacheControl(declared));
    return { kind: 'served', cacheControl: effective };
  } catch (error) {
    // Never a bare rethrow: a non-`UltimateError` escaping here would otherwise be reported as an
    // agreement between the two surfaces, which is the one answer this file must not invent.
    if (!(error instanceof UltimateError)) throw error;
    return { kind: 'refused', code: error.code };
  }
}

function contextFor(url: URL, params: Record<string, string>, actor: Actor): RequestContext {
  const ctx = createRequestContext({
    url,
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  ctx.params = params;
  ctx.actor = actor;
  return ctx;
}

/** The `/media` surface, driven the way the pipeline drives it. */
function mediaVerdict(key: string, actor: Actor, query = ''): Promise<Verdict> {
  const routes: readonly Route[] = assetRoutes({ root, storage });
  const route = routes.find((candidate) => candidate.path === `${MEDIA_BASE_PATH}/*key`);
  expect(route).toBeDefined();
  const url = new URL(`http://dev.test${MEDIA_BASE_PATH}/${key}${query}`);
  const ctx = contextFor(url, { key }, actor);
  return verdictOf(
    async () =>
      route === undefined
        ? new Response(null, { status: 404 })
        : route.handler(new UltimateRequest(new Request(url), ctx), ctx),
    route?.meta.cache,
  );
}

/** The `/_storage` surface, same object, same actor. */
function storageVerdict(key: string, actor: Actor): Promise<Verdict> {
  const route = storageRoutes({ storage })[0];
  expect(route?.path).toBe(`${STORAGE_BASE_PATH}/:disk/*key`);
  const disk = storage.defaultDisk;
  const url = new URL(`http://dev.test${STORAGE_BASE_PATH}/${disk}/${key}`);
  const ctx = contextFor(url, { disk, key }, actor);
  return verdictOf(
    async () =>
      route === undefined
        ? new Response(null, { status: 404 })
        : route.handler(new UltimateRequest(new Request(url), ctx), ctx),
    route?.meta.cache,
  );
}

const reader = (roles: readonly string[], orgId: string | undefined): Actor =>
  userActor({ id: 'u-1', roles: [...roles], ...(orgId === undefined ? {} : { orgId }) });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-surfaces-'));
  storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.storage') }) } });
  await storage.disk().put(SCOPED_KEY, BYTES, { contentType: 'image/png' });
  await storage.disk().put(UNSCOPED_KEY, BYTES, { contentType: 'image/png' });
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] }, guest: { grants: [] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

/** Rendered from the declaration rather than spelled, so an edit to the hint reaches these cases. */
const AUTHORIZED = cacheControl(AUTHORIZED_OBJECT_CACHE);
const IMMUTABLE = 'public, max-age=31536000, immutable';

interface SurfaceCase {
  readonly label: string;
  readonly actor: Actor;
  /** What BOTH surfaces must answer for a tenant-scoped object. */
  readonly scoped: Verdict;
  /** The code both must answer for an object no tenant owns, or `null` when it is served. */
  readonly unscopedCode: string | null;
}

describe('unit · storage surfaces · one object, two routes, one verdict', () => {
  const cases: readonly SurfaceCase[] = [
    {
      label: 'the owning org',
      actor: reader(['member'], 'org-a'),
      scoped: { kind: 'served', cacheControl: AUTHORIZED },
      unscopedCode: null,
    },
    {
      label: 'another org',
      actor: reader(['member'], 'org-b'),
      scoped: { kind: 'refused', code: 'X_STORAGE_ORG_MISMATCH' },
      unscopedCode: null,
    },
    {
      label: 'an actor with no org',
      actor: reader(['member'], undefined),
      scoped: { kind: 'refused', code: 'X_STORAGE_ORG_MISMATCH' },
      unscopedCode: null,
    },
    {
      label: 'a role that grants nothing',
      actor: reader(['guest'], 'org-a'),
      scoped: { kind: 'refused', code: 'X_FORBIDDEN' },
      unscopedCode: 'X_FORBIDDEN',
    },
    {
      label: 'nobody',
      actor: anonymousActor(),
      scoped: { kind: 'refused', code: 'X_UNAUTHENTICATED' },
      unscopedCode: 'X_UNAUTHENTICATED',
    },
  ];

  for (const { label, actor, scoped, unscopedCode } of cases) {
    test(`a tenant-scoped object answers ${label} identically on both surfaces`, async () => {
      const media = await mediaVerdict(SCOPED_KEY, actor);
      const stored = await storageVerdict(SCOPED_KEY, actor);
      // Named absolutely AND compared: `expect(media).toEqual(stored)` alone is satisfied by both
      // surfaces failing open together, which is exactly what a guard they now SHARE makes
      // possible — the cross-surface half catches drift, the literal half catches a hole.
      expect(media).toEqual(scoped);
      expect(stored).toEqual(scoped);
    });

    test(`an unscoped object answers ${label} with the same authz verdict`, async () => {
      const media = await mediaVerdict(UNSCOPED_KEY, actor);
      const stored = await storageVerdict(UNSCOPED_KEY, actor);
      if (unscopedCode !== null) {
        expect(media).toEqual({ kind: 'refused', code: unscopedCode });
        expect(stored).toEqual({ kind: 'refused', code: unscopedCode });
        return;
      }
      // Served on both — and this is the one place the two legitimately differ: an unscoped key
      // belongs to no tenant, so `/media` may still hand it to a CDN while `/_storage`
      // revalidates. Who may read it is not negotiable; how long a cache may hold it is.
      expect(media).toEqual({ kind: 'served', cacheControl: IMMUTABLE });
      expect(stored).toEqual({ kind: 'served', cacheControl: AUTHORIZED });
    });
  }
});

describe('unit · storage surfaces · what a shared cache may keep', () => {
  test('a tenant-scoped object is never public or immutable on /media', async () => {
    const media = await mediaVerdict(SCOPED_KEY, reader(['member'], 'org-a'));
    expect(media.kind).toBe('served');
    if (media.kind !== 'served') return;
    // The bug this closes: `public, max-age=31536000, immutable` on one tenant's private object
    // means any CDN or shared proxy serves it to every other tenant under the same URL for a year.
    expect(media.cacheControl).not.toContain('public');
    expect(media.cacheControl).not.toContain('immutable');
  });

  test('an unscoped object keeps the immutable hint the variant URL depends on', async () => {
    const media = await mediaVerdict(UNSCOPED_KEY, reader(['member'], 'org-a'));
    expect(media).toEqual({
      kind: 'served',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });
});

describe('unit · storage surfaces · the transform is a write', () => {
  test('an unauthorized ?w= mints no object in the bucket', async () => {
    const cached = variantKey(SCOPED_KEY, { width: 320, format: 'png' });
    const media = await mediaVerdict(SCOPED_KEY, anonymousActor(), '?w=320&f=png');
    expect(media.kind).toBe('refused');
    // The aggravator: `transformedVariant` ends in `disk.put`, so an unauthenticated transform is
    // an anonymous writer minting new objects on the app's only disk.
    expect(await storage.disk().exists(cached)).toBe(false);
  });

  test('an authorized ?w= still caches its variant', async () => {
    const cached = variantKey(SCOPED_KEY, { width: 320, format: 'png' });
    const media = await mediaVerdict(SCOPED_KEY, reader(['member'], 'org-a'), '?w=320&f=png');
    expect(media.kind).toBe('served');
    expect(await storage.disk().exists(cached)).toBe(true);
  });
});
