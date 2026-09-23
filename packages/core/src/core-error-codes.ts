// Single responsibility: core's OWN error-code titles, registered at import. A side-effect
// anchor, bare-imported by the barrel — the same shape as `schema-error-codes.ts` — so the table
// rides every barrel import and none of the light paths: `UltimateError` alone no longer carries
// 40 titles into a browser island that throws one code. Listed in `SIDE_EFFECTS_ANCHORS`.

import type { ErrorCodeDescriptor } from './error-codes';
import { descriptor, registerCoreErrorCodes } from './error-codes';

/** Codes owned by `@ultimat3/core`. Every other package calls `registerErrorCodes()`. */
const CORE_CODE_TITLES = {
  X_ABORTED: 'operation aborted',
  X_ASYNC_CONTEXT_UNAVAILABLE: 'async context unavailable',
  // The browser seam's three (`client-transport.ts`, `record-envelope.ts`, `client-scope.ts`).
  X_CLIENT_RECORD_ENVELOPE_INVALID: 'a response marked as a records envelope has the wrong shape',
  X_CLIENT_SCOPE_CHANGED: 'the page changed principal while this request was in flight',
  X_CLIENT_TRANSPORT_FAILED: 'a browser request got no answer from the app',
  X_CONFIG_INVALID: 'app.config.ts is invalid',
  X_CURSOR_INVALID: 'pagination cursor is malformed, tampered with or from another query',
  X_CURSOR_SECRET_DEV: 'cursors are signed with the shipped development key',
  X_DRAINING: 'process is draining and refuses new work',
  X_ENV_EXAMPLE_DRIFT: '.env.example does not declare every variable the schema requires',
  X_ENV_MISSING: 'required environment variables are missing or invalid',
  X_ENVIRONMENT_INVALID: 'ULTIMATE_ENV is not a known environment',
  X_ERROR_CODE_DUPLICATE: 'error code registered twice',
  X_ERROR_REPORTER_DSN_INVALID: 'the error monitor DSN is malformed',
  X_ERROR_RETRY_INVALID: 'error retry classification is unknown or already claimed',
  // Core's own, and deliberately NOT `@ultimat3/http`'s `X_OVERLOADED`: that code is owned by a
  // tier-2 package, and a tier-0 gate borrowing it upward is an import core may not make. The two
  // read alike to an operator and the fix lines say which ceiling to widen.
  X_FLIGHT_GATE_OVERLOADED: 'a concurrency gate is at its ceiling and its queue is full',
  X_ID_INVALID: 'value is not a valid id',
  X_IMAGE_DECODE_FAILED: 'image bytes are malformed, truncated or internally inconsistent',
  X_IMAGE_TOO_LARGE: 'image exceeds the pipeline pixel ceiling',
  X_IMAGE_UNSUPPORTED: 'the built-in image pipeline cannot read or write this format',
  X_INTERNAL: 'unexpected internal framework error',
  X_INVARIANT: 'invariant violated',
  // Owned here rather than by `@ultimat3/time`, which declared it until 16.x: `@ultimat3/money`
  // needs the same screen and tier 1 may not import sideways. One code, one declaration.
  X_LOCALE_INVALID: 'not a well-formed BCP 47 tag',
  X_METRIC_CARDINALITY:
    'a metric exceeded its series ceiling and is folding into one overflow series',
  X_METRIC_NAME_INVALID:
    'metric name is malformed, or redeclared with a different kind, bounds or observer',
  X_METRIC_VALUE_INVALID: 'metric value is not recordable',
  X_NO_CONTEXT: 'no request context is active',
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
  X_OTLP_ENDPOINT_INVALID: 'the OTLP collector endpoint is missing or malformed',
  // Its own code rather than the endpoint's, because a title is what an agent reads first:
  // `x errors explain X_OTLP_ENDPOINT_INVALID` would send it to inspect a variable that is fine.
  X_OTLP_HEADERS_INVALID: 'OTEL_EXPORTER_OTLP_HEADERS is malformed',
  X_OTLP_PROTOCOL_UNSUPPORTED: 'the OTLP protocol requested is not OTLP/HTTP JSON',
  X_READINESS_CHECK_DUPLICATE: 'a readiness check name is registered twice',
  X_REGISTRAR_CONFLICT: 'two different registrars are loaded for one primitive kind',
  X_REGISTRAR_MISSING: 'no registrar is loaded for a primitive kind',
  X_ROLE_INVALID: 'ROLE is not a known runtime role',
  X_SERVICE_DUPLICATE: 'a service name is registered twice',
  X_SERVICE_MISSING: 'service is not registered on the request context',
  X_SHUTDOWN_TIMEOUT: 'graceful shutdown exceeded its deadline',
  X_SUPERSEDED: 'a later generation superseded this work',
  X_TELEMETRY_SAMPLER_ARG_INVALID: 'the trace sampling ratio is not a number between 0 and 1',
  // Core's, though core does not throw it — the twin of `X_ABORTED`, and `@ultimat3/http` already
  // calls it "borrowed (core's concept)" in `HTTP_BORROWED_ERROR_CODES`. A deadline that expired
  // and a caller that went away are one pair of facts, so they are titled and classified in one
  // place rather than by whichever package happened to raise one first.
  X_TIMEOUT: 'operation exceeded its deadline',
  X_UNREACHABLE: 'unreachable branch was reached',
} as const;

export type CoreErrorCode = keyof typeof CORE_CODE_TITLES;

export const CORE_ERROR_CODES: Readonly<Record<CoreErrorCode, ErrorCodeDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CORE_CODE_TITLES).map(([code, title]) => [code, descriptor({ title })]),
  ) as Record<CoreErrorCode, ErrorCodeDescriptor>,
);

registerCoreErrorCodes(CORE_ERROR_CODES);
