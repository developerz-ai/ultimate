/**
 * The refusals of the HTTP declaration an app makes about its actions: a pinned `http.path`, the
 * app's `pathStyle`, and the `openapi` block. Split from `errors.ts` at its ceiling; the codes and
 * titles are registered in `error-titles.ts`, one registry, imported bare so constructing one of
 * these registers its title first.
 */

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import './error-titles';

export class ActionHttpPathInvalidError extends UltimateError {
  constructor(input: { name: string; path: unknown; reason: string }) {
    super({
      code: 'X_ACTION_HTTP_PATH_INVALID',
      cause: `action "${input.name}" pins http.path ${renderCauseValue(input.path)}, which ${input.reason}`,
      fix: "pin a static lowercase path: http: { path: '/api/webhooks/wompi' } — a leading slash, segments of a-z 0-9 . _ ~ -, no :param or *wildcard, no trailing slash, never under /_x",
      meta: { action: input.name },
    });
  }
}

export class ActionPathStyleInvalidError extends UltimateError {
  constructor(value: unknown) {
    super({
      code: 'X_ACTION_PATH_STYLE_INVALID',
      cause: `defineApi({ http: { pathStyle: ${renderCauseValue(value)} } }) is not 'resource' or 'readable'`,
      fix: "defineApi({ ..., http: { pathStyle: 'readable' } }) — or omit it for 'resource', the default",
    });
  }
}

/**
 * A path was handed out under one style and the app then declared another. The string is already
 * captured — a module-level `const SIGN_OUT = derivePath('signOut').path` — so re-deriving the
 * registry cannot reach it: that form would post to a URL no route serves. Refused at the
 * declaration, naming every stale capture, rather than answered 404 in production.
 */
export class ActionPathDerivedEarlyError extends UltimateError {
  constructor(input: {
    readonly style: string;
    readonly stale: readonly {
      readonly name: string;
      readonly was: string;
      readonly now: string;
    }[];
  }) {
    const shown = input.stale
      .slice(0, 5)
      .map((row) => `${row.name} (${row.was}, now ${row.now})`)
      .join(', ');
    const more = input.stale.length > 5 ? ` and ${input.stale.length - 5} more` : '';
    super({
      code: 'X_ACTION_PATH_DERIVED_EARLY',
      cause: `pathStyle '${input.style}' was declared after a path was already derived under the previous style: ${shown}${more} — any module that kept that string holds a URL no route serves`,
      fix: 'derive the path where it is used — inside the component or function, never in a module-level const — or import the module that calls defineApi({ http: { pathStyle } }) before the one that derives it',
      meta: { style: input.style, names: input.stale.map((row) => row.name) },
    });
  }
}

export class OpenApiConfigInvalidError extends UltimateError {
  constructor(reason: string) {
    super({
      code: 'X_OPENAPI_CONFIG_INVALID',
      cause: `defineApi({ openapi }) cannot produce a valid document: ${reason}`,
      fix: "defineApi({ ..., openapi: { title: 'My API', version: '1.0.0', servers: [{ url: 'https://www.example.com' }] } }) — non-empty title and version, absolute http(s) server URLs, and a mount document named like 'openapi.v1.json'",
    });
  }
}
