// CORS with a locked default: same-origin only. Cross-origin access is a decision the app makes
// once, in `configureHttp({ cors })`, never something a route can quietly opt into.

import { corsConfigInvalid } from './errors';

export interface CorsConfig {
  /** Exact origins. `'*'` is allowed only when `credentials` is false. */
  readonly origins: readonly string[];
  readonly methods: readonly string[];
  readonly allowHeaders: readonly string[];
  readonly exposeHeaders: readonly string[];
  readonly credentials: boolean;
  readonly maxAgeSeconds: number;
}

export const DEFAULT_CORS: CorsConfig = {
  origins: [],
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['content-type', 'authorization', 'x-ultimate-build', 'x-request-id'],
  exposeHeaders: ['x-request-id', 'x-ultimate-build', 'retry-after'],
  credentials: true,
  maxAgeSeconds: 600,
};

/**
 * The one combination the browser refuses — `*` with credentials — refused HERE instead, at the
 * one moment an author can act on it. It used to resolve to "no CORS headers at all": the natural
 * "open it up" edit produced total, silent CORS failure and a console full of unexplained blocks,
 * with `DEFAULT_CORS.credentials` (true) as the half nobody thinks to look at.
 */
export const assertCorsConfig = (config: CorsConfig): void => {
  if (config.origins.includes('*') && config.credentials) {
    throw corsConfigInvalid(
      "origins includes '*' while credentials is true — no browser accepts that pair",
    );
  }
};

/**
 * The one answer to "may this origin talk to us?". Exported for `csrf.ts`, which asks the same
 * question about a *request* rather than a response — a second list of allowed origins would be
 * a CORS policy and a CSRF policy that quietly disagree.
 */
export const allowedOrigin = (config: CorsConfig, origin: string | null): string | null => {
  if (origin === null) return null;
  if (config.origins.includes('*')) return config.credentials ? null : '*';
  return config.origins.includes(origin) ? origin : null;
};

/**
 * Headers to merge into every response, preflight or not.
 *
 * A refused origin still gets `vary: origin`, which is the header that keeps the answer *out* of a
 * shared cache's un-keyed slot: without it a CDN stores the un-CORS'd body under the URL alone and
 * hands it to an allowed origin next, whose fetch then fails for a reason nothing in that request
 * explains.
 */
export const corsHeaders = (config: CorsConfig, origin: string | null): Record<string, string> => {
  const allow = allowedOrigin(config, origin);
  // Caches must not serve one origin's response to another — refusal included.
  if (allow === null) return { vary: 'origin' };
  const headers: Record<string, string> = {
    'access-control-allow-origin': allow,
    vary: 'origin',
  };
  if (config.credentials) headers['access-control-allow-credentials'] = 'true';
  if (config.exposeHeaders.length > 0) {
    headers['access-control-expose-headers'] = config.exposeHeaders.join(', ');
  }
  return headers;
};

/**
 * Answers an OPTIONS preflight. Returns `undefined` when the request is not a
 * preflight so the caller can fall through to the normal pipeline.
 */
export const preflight = (request: Request, config: CorsConfig): Response | undefined => {
  if (request.method !== 'OPTIONS') return undefined;
  const requested = request.headers.get('access-control-request-method');
  if (requested === null) return undefined;
  const origin = request.headers.get('origin');
  const allow = allowedOrigin(config, origin);
  if (allow === null) return new Response(null, { status: 403, headers: { vary: 'origin' } });
  const headers = new Headers(corsHeaders(config, origin));
  headers.set('access-control-allow-methods', config.methods.join(', '));
  headers.set('access-control-allow-headers', config.allowHeaders.join(', '));
  headers.set('access-control-max-age', String(config.maxAgeSeconds));
  return new Response(null, { status: 204, headers });
};
