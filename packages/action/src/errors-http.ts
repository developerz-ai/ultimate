/**
 * The refusals of the HTTP declaration an app makes about its actions: a pinned `http.path`, the
 * app's `pathStyle`, and the `openapi` block. Split from `errors.ts` at its ceiling; the codes and
 * titles stay registered there, one registry.
 */

import { renderCauseValue, UltimateError } from '@ultimat3/core';

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

export class OpenApiConfigInvalidError extends UltimateError {
  constructor(reason: string) {
    super({
      code: 'X_OPENAPI_CONFIG_INVALID',
      cause: `defineApi({ openapi }) cannot produce a valid document: ${reason}`,
      fix: "defineApi({ ..., openapi: { title: 'My API', version: '1.0.0', servers: [{ url: 'https://www.example.com' }] } }) — non-empty title and version, absolute http(s) server URLs, and a mount document named like 'openapi.v1.json'",
    });
  }
}
