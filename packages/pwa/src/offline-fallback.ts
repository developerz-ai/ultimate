/**
 * The offline fallback is mandatory. A PWA whose first offline navigation shows the
 * browser's dinosaur is not offline-capable — it is a website with a manifest. The type
 * requires it and `requireOfflineFallback` fails the build if it is missing.
 */

import { PwaNoOfflineFallbackError } from './errors';

export interface OfflineConfig {
  /** Route path of the offline document, e.g. `/offline`. Required. */
  readonly fallback: string;
  /** Optional per-content-type fallbacks. */
  readonly image?: string;
  readonly font?: string;
  /** Requests that must never be answered from a cache (auth, payments). */
  readonly neverCache?: readonly string[];
}

export interface OfflineFallback {
  readonly document: string;
  readonly image: string | null;
  readonly font: string | null;
  readonly neverCache: readonly string[];
}

const FIX = 'create app/offline.tsx and set offline.fallback';

/**
 * Build-time gate, called by `generateServiceWorker` and by `x doctor`. The fix line is
 * the literal two-step edit, not a doc link.
 */
export function requireOfflineFallback(
  config: Partial<OfflineConfig> | undefined | null,
): OfflineFallback {
  if (config === undefined || config === null) {
    throw new PwaNoOfflineFallbackError(
      'app.config.ts has no `offline` block, so an offline navigation would show the ' +
        "browser's error page",
      FIX,
    );
  }
  const fallback = config.fallback;
  if (fallback === undefined || fallback.trim() === '') {
    throw new PwaNoOfflineFallbackError(
      'app.config.ts has an `offline` block with no `fallback` route',
      FIX,
    );
  }
  if (!fallback.startsWith('/')) {
    throw new PwaNoOfflineFallbackError(
      `offline.fallback is ${JSON.stringify(fallback)}, which is not an absolute route path`,
      `set offline.fallback to '/${fallback.replace(/^\/+/, '')}'`,
    );
  }

  return {
    document: fallback,
    image: config.image ?? null,
    font: config.font ?? null,
    neverCache: config.neverCache ?? [],
  };
}

/** Emitted into `sw.js`: what to serve when a navigation cannot be answered. */
export function offlineFallbackSource(fallback: OfflineFallback): string {
  const image = fallback.image === null ? 'null' : JSON.stringify(fallback.image);
  return `
const OFFLINE_DOC=${JSON.stringify(fallback.document)};
const OFFLINE_IMAGE=${image};
async function offlineFallback(req){
  const c=await caches.open(PRECACHE);
  if(req.mode==='navigate'){const d=await c.match(OFFLINE_DOC);if(d)return d}
  if(OFFLINE_IMAGE&&req.destination==='image'){const i=await c.match(OFFLINE_IMAGE);if(i)return i}
  return new Response('',{status:503,statusText:'Offline'})
}`.trim();
}
