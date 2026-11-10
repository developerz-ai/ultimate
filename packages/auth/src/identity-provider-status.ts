// Single responsibility: the code → HTTP status table the sign-in route descriptors answer with
// when driven outside a pipeline — one table for every IdentityProvider route, OIDC and SAML alike,
// pinned to `@ultimat3/http`'s `statusFor` by `scripts/oauth-route-status.test.ts` and
// `scripts/identity-route-status.test.ts`.

/**
 * HTTP status per code for the sign-in descriptors (`identityProviderRoutes`, and `oauthLogin` over
 * it), driven OUTSIDE a pipeline — a bare `Request` in, a
 * `Response` out, which is the whole point of a descriptor. `@ultimat3/http`'s `error-map.ts` OWNS
 * these numbers and is where a new one is declared; this package is the same tier and can never
 * import it, so the table is a copy the pin `scripts/oauth-route-status.test.ts` holds identical to
 * `statusFor()`. Everything absent is the provider's fault until proven otherwise: 502.
 */
export const OAUTH_ROUTE_STATUS: Readonly<Record<string, number>> = {
  X_OAUTH_PROVIDER_UNKNOWN: 404,
  X_OAUTH_DENIED: 403,
  X_OAUTH_STATE_INVALID: 400,
  X_OAUTH_TOKEN_INVALID: 400,
  X_UNAUTHENTICATED: 401,
  X_MFA_REQUIRED: 401,
  X_ACCOUNT_LOCKED: 429,
  X_ENV_MISSING: 500,
  X_CONFIG_INVALID: 500,
  X_SAML_RESPONSE_INVALID: 400,
  X_SAML_METADATA_INVALID: 500,
  X_IDENTITY_PROVIDER_UNKNOWN: 404,
};

/**
 * The status for a code, read as an OWN key of the table above.
 *
 * `OAUTH_ROUTE_STATUS[code] ?? 502` is an index read on a plain object, so `Object.prototype`
 * answered for `toString`, `constructor`, `hasOwnProperty` and `__proto__` — and `toString`
 * yields a FUNCTION, which was handed straight to `ResponseInit.status`. `code` is a plain
 * `string` on every `UltimateError`, so no cast makes that unreachable. Fourth instance of the
 * class in the framework, after i18n's catalog lookup, schema's `coerce` and mcp's `validate-args`.
 *
 * Exported so a test can drive it without building a `Response`; `OAUTH_ROUTE_STATUS` stays
 * exported unchanged, because `scripts/oauth-route-status.test.ts` pins it against
 * `@ultimat3/http`'s `statusFor`.
 */
export function oauthRouteStatus(code: string): number {
  // 502 is the default: an uncoded throw on this path came out of the provider conversation.
  return Object.hasOwn(OAUTH_ROUTE_STATUS, code) ? (OAUTH_ROUTE_STATUS[code] ?? 502) : 502;
}
