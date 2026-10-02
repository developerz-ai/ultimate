// `authRequest()` — the two arguments `hooks.authenticate` is handed, built the way the pipeline
// builds them, so a test of an app's authenticator calls it with no server and no cast.
// `@ultimat3/http` is imported INSIDE the function: this module is on the `.` barrel, which a
// tier-0 test imports for `expect` alone.

import type { Authenticator } from '@ultimat3/http';

/** What an authenticator reads off a request: where it came in, and the credentials it carries. */
export interface AuthRequestInit {
  /** The URL the request names. `https://example.test/` when absent. */
  readonly url?: string;
  /** `GET` when absent. */
  readonly method?: string;
  /** Any header. `cookies` and `bearer` below win over the same header spelled here. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Cookies by name, sent as the ONE `cookie` header a browser sends, values percent-encoded. */
  readonly cookies?: Readonly<Record<string, string>>;
  /** `Authorization: Bearer <token>`. */
  readonly bearer?: string;
}

const DEFAULT_URL = 'https://example.test/';

/**
 * The authenticator's own parameter list — `await authenticate(...(await authRequest({ cookies })))`
 * — as a real `UltimateRequest` over a real `RequestContext`. Typed off `Authenticator`, so a
 * third parameter on the hook is a compile error here rather than an `undefined` in a test.
 *
 * The context is the one the `auth` stage sees: the actor is still anonymous, because resolving
 * it is the function under test.
 */
export async function authRequest(init: AuthRequestInit = {}): Promise<Parameters<Authenticator>> {
  const http = await import('@ultimat3/http');
  const url = new URL(init.url ?? DEFAULT_URL);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const cookies = Object.entries(init.cookies ?? {});
  if (cookies.length > 0) {
    headers.set(
      'cookie',
      cookies.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '),
    );
  }
  if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
  const ctx = http.createRequestContext({
    url,
    method,
    role: 'web',
    // One process, one test: the limiter's scope has no default, and nothing here spends a bucket.
    config: http.defineHttpConfig({ rateLimit: { scope: 'process' } }),
    requestHeaders: headers,
  });
  return [new http.UltimateRequest(new Request(url, { method, headers }), ctx), ctx];
}
