/**
 * The offline fallback is mandatory. A PWA whose first offline navigation shows the
 * browser's dinosaur is not offline-capable — it is a website with a manifest. The type
 * requires it and `requireOfflineFallback` fails the build if it is missing.
 */

import { PwaNoOfflineFallbackError } from './errors';
import type { PersonalPages } from './pages-cache-source';

export interface OfflineConfig {
  /** Route path of the offline document, e.g. `/offline`. Required. */
  readonly fallback: string;
  /** Optional per-content-type fallbacks. */
  readonly image?: string;
  readonly font?: string;
  /** Requests that must never be answered from a cache (auth, payments). */
  readonly neverCache?: readonly string[];
  /** A page rendered for someone: `'never'` cached (default), or `'last-member'`. `PersonalPages`. */
  readonly personalPages?: PersonalPages;
}

export interface OfflineFallback {
  readonly document: string;
  readonly image: string | null;
  readonly font: string | null;
  readonly neverCache: readonly string[];
  readonly personalPages: PersonalPages;
}

/**
 * The edit, then the command — TWO actions, and neither is optional. It was `create
 * app/offline.tsx and set offline.fallback`, and both halves were wrong: `<name>.tsx` is not a
 * route file at all — `registerRoute` refuses it with `X_ROUTE_FILE_INVALID` because the
 * directory is the URL — and `offline.fallback` names no key `app.config.ts` has. So a reader who
 * followed this line literally created a component nothing imports, left `/offline` a URL that
 * does not exist, and met the same refusal on the next build. `wiki/Upgrading.md` already recorded
 * `apps/web/app/offline.tsx` as the wrong path.
 *
 * The edit comes FIRST, and the command is not the head of the line: with `x g route …   # then
 * set …` the second half was a shell COMMENT, so the line read as one paste that does the whole
 * job and did half of it — the route appeared, `pwa.offline.fallback` stayed unset, and the very
 * next build raised this same error. A `fix:` that half-runs is worse than one that names two
 * steps, because the reader has no signal that anything is left. The contract's own accepted
 * shape is an edit naming its file (`set auth.signInPath = '/signin' in app.config.ts`).
 *
 * `--surface site`, and not `app`: the document that answers a lost network must render with no
 * network, no session and no database, which `app/` (`ssr | stream`) cannot promise — and only a
 * `static` route is prerendered, so an `app/` fallback has no document to precache at all. The
 * command writes `apps/web/site/offline/page.tsx`, which is what `x new` scaffolds.
 */
const FIX =
  "set pwa: { offline: { fallback: '/offline' } } in app.config.ts, then create the route it names: x g route offline --surface site";

/**
 * Build-time gate, called by `generateServiceWorker` and by `x doctor`. The fix line is
 * the config edit plus the command that creates the route it names, not a doc link.
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
      `set pwa.offline.fallback to '/${fallback.replace(/^\/+/, '')}' in app.config.ts`,
    );
  }
  if (!sameOriginPath(fallback)) throw offOrigin('fallback', fallback, '/offline');

  return {
    document: fallback,
    image: placeholder('image', config.image, '/icons/offline.png'),
    font: placeholder('font', config.font, '/fonts/fallback.woff2'),
    neverCache: config.neverCache ?? [],
    personalPages: config.personalPages === 'last-member' ? 'last-member' : 'never',
  };
}

/**
 * A path on THIS origin: `/…`, never `//host` or `/\host` — both start with `/` and a browser
 * resolves both to another host. Every URL here is precached at install and served as the answer
 * to a failed request, so an off-origin one is a third party's bytes in the app's cache.
 */
function sameOriginPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');
}

function offOrigin(key: string, url: string, example: string): PwaNoOfflineFallbackError {
  return new PwaNoOfflineFallbackError(
    `pwa.offline.${key} is ${JSON.stringify(url)}, which is not a path on this origin — it is precached and served as the offline answer`,
    `defineConfig({ pwa: { offline: { ${key}: '${example}' } } })   # pwa.offline.${key} in app.config.ts — a path this app serves`,
  );
}

/** `pwa.offline.image` / `.font`: absent is `null`; present must be a same-origin path. */
function placeholder(
  key: 'image' | 'font',
  url: string | undefined,
  example: string,
): string | null {
  if (url === undefined || url === null) return null;
  if (!sameOriginPath(url)) throw offOrigin(key, url, example);
  return url;
}

/**
 * Emitted into `sw.js`: what to serve when a request cannot be answered — the offline document for
 * a navigation, the `image`/`font` placeholders for those destinations (each only if the app
 * precached it), else a 503. `localePrefixes` are the non-default routed locales' URL segments: a
 * navigation under `/en/` tries `/en` + the offline document first, so an English visitor offline
 * is not handed the default locale's page.
 */
export function offlineFallbackSource(
  fallback: OfflineFallback,
  localePrefixes: readonly string[] = [],
): string {
  const image = fallback.image === null ? 'null' : JSON.stringify(fallback.image);
  const font = fallback.font === null ? 'null' : JSON.stringify(fallback.font);
  const locales = [...new Set(localePrefixes)].sort();
  return `
const OFFLINE_DOC=${JSON.stringify(fallback.document)};
const OFFLINE_IMAGE=${image};
const OFFLINE_FONT=${font};
const OFFLINE_LOCALES=${JSON.stringify(locales)};
async function offlineFallback(req){
  const c=await caches.open(PRECACHE);
  if(req.mode==='navigate'){
    const seg=new URL(req.url).pathname.split('/')[1];
    if(OFFLINE_LOCALES.indexOf(seg)!==-1){const l=await c.match('/'+seg+OFFLINE_DOC);if(l)return l}
    const d=await c.match(OFFLINE_DOC);if(d)return d
  }
  if(OFFLINE_IMAGE&&req.destination==='image'){const i=await c.match(OFFLINE_IMAGE);if(i)return i}
  if(OFFLINE_FONT&&req.destination==='font'){const f=await c.match(OFFLINE_FONT);if(f)return f}
  return new Response('',{status:503,statusText:'Offline'})
}`.trim();
}
