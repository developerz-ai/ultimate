// Single responsibility: the callback leg's path pattern — the default, or an app's own
// (`oauthLogin({ callbackPath })`) — refused at construction when a router could not mount it or the
// provider could not be read back out of it. One value yields the mount, the `redirect_uri` sent
// to the IdP and the provider segment of an arriving request, so the three cannot disagree.

import { ConfigInvalidError, renderCauseValue } from '@ultimat3/core';
import { OAUTH_CALLBACK_ROUTE_PATH, OAUTH_START_ROUTE_PATH } from './oauth-paths';

const PARAM = ':provider';

export interface CallbackPath {
  /** The mount pattern, `:provider` included. */
  readonly pattern: string;
  /** The concrete path for one provider: what `redirect_uri` carries. */
  pathFor(provider: string): string;
  /** The provider segment of a request this pattern matched, counted from the END of the path. */
  providerOf(pathname: string): string;
}

const split = (path: string): string[] => path.split('/').filter((part) => part !== '');

function refuse(pattern: string, why: string): ConfigInvalidError {
  return new ConfigInvalidError({
    cause: `oauthLogin({ callbackPath: ${renderCauseValue(pattern)} }) ${why}`,
    fix: "oauthLogin(auth, { callbackPath: '/auth/oauth/:provider/callback' })  // absolute, one whole ':provider' segment, no other parameter, not the start path",
  });
}

/**
 * Counted from the end so a router mounting the routes under a prefix still finds the segment —
 * the default's `parts.length - 2` before this file existed.
 */
export function callbackPath(pattern: string = OAUTH_CALLBACK_ROUTE_PATH): CallbackPath {
  if (!pattern.startsWith('/')) throw refuse(pattern, 'is not an absolute path');
  if (/[?#*]/.test(pattern)) throw refuse(pattern, 'carries a query, fragment or wildcard');
  if (pattern === OAUTH_START_ROUTE_PATH) throw refuse(pattern, 'is the start leg’s own path');
  const parts = split(pattern);
  const params = parts.filter((part) => part.includes(':'));
  if (params.length !== 1 || params[0] !== PARAM) {
    throw refuse(pattern, 'must carry exactly one parameter, the whole segment :provider');
  }
  const fromEnd = parts.length - 1 - parts.indexOf(PARAM);
  return Object.freeze({
    pattern,
    pathFor: (provider: string) => pattern.replace(PARAM, provider),
    providerOf(pathname: string) {
      const segments = split(pathname);
      return segments[segments.length - 1 - fromEnd] ?? '';
    },
  });
}
