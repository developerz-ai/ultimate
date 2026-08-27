// The two GET routes that serve what `sw-artifacts.ts` built, and the cache policy each one needs.
// Split from the emitter because mounting is HTTP and generation is a build: `prerender.ts` writes
// both artifacts as files and mounts nothing, and it must not have to import a route table to do it.

import type { CacheHint, Route } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import type { ServiceWorkerArtifacts } from './sw-artifacts';
import { SERVICE_WORKER_PATH, SW_REGISTER_PATH, SW_SCOPE } from './sw-artifacts';

/**
 * `no-store`, and it is the one asset here that must be. A cached `sw.js` is a worker that cannot
 * be replaced: the browser re-fetches it to decide whether an update exists, and an intermediary
 * answering the old bytes pins every client to the deploy that shipped them. Browsers cap SW
 * script caching at 24h on their own; this removes the question.
 */
const SW_CACHE: CacheHint = { mode: 'private', maxAgeSeconds: 0 };

/** Content-addressed in neither path, so the register script gets the favicon's hour. */
const REGISTER_CACHE: CacheHint = { mode: 'public', maxAgeSeconds: 3600 };

/** `/sw.js` and `/x-sw-register.js`, mounted by `x dev` and by the container alike. */
export const serviceWorkerRoutes = (artifacts: ServiceWorkerArtifacts): readonly Route[] => [
  {
    method: 'GET',
    path: SERVICE_WORKER_PATH,
    meta: { name: 'pwa.serviceWorker', auth: 'public' },
    handler: () =>
      applyCacheHeaders(
        new Response(artifacts.source, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            // Without it the browser refuses to let a worker served from `/` control `/`, which
            // is the failure `assertScope` cannot see: the scope a REGISTRATION asks for has to be
            // allowed by the script's own response, not only by its path.
            'service-worker-allowed': SW_SCOPE,
          },
        }),
        SW_CACHE,
      ),
  },
  {
    method: 'GET',
    path: SW_REGISTER_PATH,
    meta: { name: 'pwa.serviceWorkerRegister', auth: 'public' },
    handler: () =>
      applyCacheHeaders(
        new Response(artifacts.register, {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        }),
        REGISTER_CACHE,
      ),
  },
];
