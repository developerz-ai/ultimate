// Single responsibility: the upload half of `/_storage` — the `PUT` a `grantUpload` URL names.
// `@ultimat3/storage` owns every accept decision (`acceptSignedUpload`); this file is where those
// decisions meet a `Route`, beside the GET in `runtime-storage.ts`, so `x dev` and `runRole` mount
// one write path through the one `storageRoutes()` both tables already call (#523).

import { finiteCount, readWithinLimit } from '@ultimat3/core';
import type { RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { json, NO_STORE } from '@ultimat3/http';
import type { Storage } from '@ultimat3/storage';
import {
  acceptSignedUpload,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_SIGNED_URL_BASE,
  objectNotFound,
  signedUploadConstraints,
  tooLarge,
  uploadPolicy,
} from '@ultimat3/storage';

/**
 * The route's URL is the capability, so the one thing read off the request before it is verified
 * is the URL itself — path and query exactly as the grant signed them.
 */
const signedUrlOf = (request: UltimateRequest): string =>
  `${request.url.pathname}${request.url.search}`;

/**
 * The GRANT is the policy. `grantUpload` refused a type and a size the app's `uploadPolicy` did not
 * allow before it signed, and the signature carries both — so the accept validates against what
 * was signed, never against `uploadPolicy()`'s image-only default, which would refuse every PDF an
 * app granted on purpose. The magic-byte sniff still runs: a signature bounds the declared type,
 * the bytes still have to be it.
 */
async function acceptUpload(
  storage: Storage,
  request: UltimateRequest,
  ctx: RequestContext,
): Promise<Response> {
  const diskName = request.params['disk'] ?? '';
  const key = request.params['key'] ?? '';
  // The GET's answer for a disk this app does not have, for the GET's reason: a refusal that lists
  // the configured disks tells a caller which names exist.
  if (!storage.diskNames.includes(diskName)) throw objectNotFound(diskName, key);
  const disk = storage.disk(diskName);
  const url = signedUrlOf(request);
  // The actor's org, never one off the request: `acceptSignedUpload` holds the verified key to it.
  const orgId = ctx.actor.orgId ?? '';

  // Verified BEFORE the body is read, so the signed ceiling caps the read — not `bodyLimitBytes`,
  // which is an RPC body's limit and would refuse every upload over a megabyte the app granted,
  // and never an unverified `?max=` a forger could raise to make this process hold gigabytes.
  const constraints = await signedUploadConstraints({ url, disk, orgId });
  // Screened as every defaulted count is: a signed ceiling is verified, but `NaN` would still read
  // as "no cap" to the counting reader below.
  const ceiling = finiteCount(
    'storageUploadRoute',
    'maxBytes',
    constraints.maxBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : constraints.maxBytes,
    1,
  );
  const read = await readWithinLimit(request.raw.body, ceiling);
  if ('over' in read) throw tooLarge(constraints.key, read.over, ceiling);

  const stored = await acceptSignedUpload({
    url,
    disk,
    orgId,
    bytes: read.bytes,
    declaredContentType: request.header('content-type') ?? undefined,
    policy: uploadPolicy({
      maxBytes: ceiling,
      ...(constraints.contentType === undefined
        ? {}
        : { allowedContentTypes: [constraints.contentType] }),
    }),
  });
  return json({ key: stored.key }, { status: 201 });
}

/**
 * `auth: 'required'` and `enforcedBy: 'handler'`, the GET's posture and for its reasons. No
 * permission: the grant is the authorization, decided by the action that minted it under its own
 * policy, and this route re-proves the three things a leaked URL must not buy — the signature,
 * the expiry, and the actor's tenant. `no-store`: a 201 for one actor's write is nothing to cache.
 */
export function storageUploadRoute(storage: Storage): Route {
  return {
    method: 'PUT',
    path: `${DEFAULT_SIGNED_URL_BASE}/:disk/*key`,
    meta: {
      name: 'storage.upload',
      auth: 'required',
      enforcedBy: 'handler',
      cache: NO_STORE,
      tags: ['storage'],
    },
    handler: (request: UltimateRequest, ctx: RequestContext): Promise<Response> =>
      acceptUpload(storage, request, ctx),
  };
}
