// Single responsibility: the pieces both OTLP exporters share — endpoint resolution from the env
// an operator already sets, header parsing, the OTLP/JSON value encoding, and one POST that never
// throws. A serialisation, not a vendor (axiom 7), exactly as `metrics-text.ts` is to Prometheus.

import { renderThrowable } from './error-render';
import { type CodedErrorInit, UltimateError } from './errors';
import { logger } from './logger';
import type { AttributeValue, SpanResource } from './telemetry';

export class OtlpEndpointInvalidError extends UltimateError {
  static readonly code = 'X_OTLP_ENDPOINT_INVALID';
  override readonly name = 'OtlpEndpointInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: OtlpEndpointInvalidError.code });
  }
}

export class OtlpProtocolUnsupportedError extends UltimateError {
  static readonly code = 'X_OTLP_PROTOCOL_UNSUPPORTED';
  override readonly name = 'OtlpProtocolUnsupportedError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: OtlpProtocolUnsupportedError.code });
  }
}

export type OtlpSignal = 'traces' | 'metrics';

export const OTLP_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const OTLP_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';
export const OTLP_PROTOCOL_KEY = 'OTEL_EXPORTER_OTLP_PROTOCOL';

/** The gRPC receiver port. Named so the error can say which one the operator reached for. */
const GRPC_PORT = '4317';

export type OtlpEnv = Readonly<Record<string, string | undefined>>;

const signalKey = (signal: OtlpSignal, suffix: string): string =>
  `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`;

/**
 * OTLP/HTTP JSON only. gRPC needs HTTP/2 plus protobuf, which is a dependency and a second wire
 * format for one signal — `docs/ops/03-observability.md` already points operators at `:4318`.
 */
function assertHttpJson(signal: OtlpSignal, url: URL, env: OtlpEnv): void {
  const protocol = (env[signalKey(signal, 'PROTOCOL')] ?? env[OTLP_PROTOCOL_KEY] ?? '').trim();
  if (protocol !== '' && protocol !== 'http/json') {
    throw new OtlpProtocolUnsupportedError({
      cause: `${OTLP_PROTOCOL_KEY}="${protocol}" — this exporter speaks OTLP/HTTP JSON and nothing else`,
      fix: `unset ${OTLP_PROTOCOL_KEY} (or set it to http/json) and point ${OTLP_ENDPOINT_KEY} at the collector's HTTP receiver, e.g. http://otel-collector:4318`,
      meta: { protocol, signal },
    });
  }
  if (url.port === GRPC_PORT) {
    throw new OtlpProtocolUnsupportedError({
      cause: `${url.origin} is the collector's gRPC receiver (:${GRPC_PORT}); OTLP/HTTP JSON is served on :4318`,
      fix: `set ${OTLP_ENDPOINT_KEY}=${url.protocol}//${url.hostname}:4318`,
      meta: { endpoint: url.origin, signal },
    });
  }
}

function parseEndpoint(signal: OtlpSignal, raw: string, perSignal: boolean, env: OtlpEnv): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OtlpEndpointInvalidError({
      cause: `"${raw}" is not a URL`,
      fix: `set ${OTLP_ENDPOINT_KEY}=http://otel-collector:4318`,
      meta: { endpoint: raw, signal },
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OtlpEndpointInvalidError({
      cause: `"${raw}" is ${url.protocol}, and OTLP/HTTP needs http or https`,
      fix: `set ${OTLP_ENDPOINT_KEY}=http://otel-collector:4318`,
      meta: { endpoint: raw, signal },
    });
  }
  assertHttpJson(signal, url, env);
  // The spec's own asymmetry, not ours: a per-signal endpoint is the full URL an operator chose,
  // while the generic one is a base the signal path is appended to.
  if (perSignal) return url.toString();
  return `${url.toString().replace(/\/+$/, '')}/v1/${signal}`;
}

/** The endpoint an operator configured, or `undefined` when they configured none. */
export function tryOtlpEndpoint(
  signal: OtlpSignal,
  env: OtlpEnv = process.env,
): string | undefined {
  const specific = env[signalKey(signal, 'ENDPOINT')]?.trim();
  if (specific !== undefined && specific !== '') return parseEndpoint(signal, specific, true, env);
  const generic = env[OTLP_ENDPOINT_KEY]?.trim();
  if (generic === undefined || generic === '') return undefined;
  return parseEndpoint(signal, generic, false, env);
}

/** The endpoint, or a coded error naming the variable to set. */
export function otlpEndpoint(
  signal: OtlpSignal,
  explicit?: string | undefined,
  env: OtlpEnv = process.env,
): string {
  if (explicit !== undefined && explicit !== '') return parseEndpoint(signal, explicit, true, env);
  const resolved = tryOtlpEndpoint(signal, env);
  if (resolved !== undefined) return resolved;
  throw new OtlpEndpointInvalidError({
    cause: `no OTLP endpoint: neither ${signalKey(signal, 'ENDPOINT')} nor ${OTLP_ENDPOINT_KEY} is set, and none was passed`,
    fix: `set ${OTLP_ENDPOINT_KEY}=http://otel-collector:4318, or skip the exporter when tryOtlpEndpoint('${signal}') is undefined`,
    meta: { signal },
  });
}

/** `key=value,key2=value2`, percent-decoded — the spec's format for collector auth headers. */
export function otlpHeaders(
  explicit?: Readonly<Record<string, string>> | undefined,
  env: OtlpEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const raw = env[OTLP_HEADERS_KEY];
  if (raw !== undefined) {
    for (const pair of raw.split(',')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim().toLowerCase();
      if (key === '') continue;
      headers[key] = decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  for (const [key, value] of Object.entries(explicit ?? {})) headers[key.toLowerCase()] = value;
  return headers;
}

export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values: readonly OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

function anyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    // `intValue` is a 64-bit field, so the JSON encoding spells it as a string. A float that
    // happens to be integral is still a double to whoever queries it; `Number.isInteger` is the
    // only signal available and matches what every other OTLP/JSON encoder does.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { arrayValue: { values: value.map((item) => anyValue(item)) } };
}

export function otlpAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): readonly OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** Epoch ms -> the string of nanoseconds OTLP/JSON wants, without losing precision to a float. */
export function unixNano(epochMs: number): string {
  return `${Math.round(epochMs)}000000`;
}

export function otlpResource(resource: SpanResource): {
  readonly attributes: readonly OtlpKeyValue[];
} {
  return {
    attributes: otlpAttributes({
      'service.name': resource.serviceName,
      'service.version': resource.serviceVersion,
    }),
  };
}

/** The instrumentation scope every signal this package emits belongs to. */
export const OTLP_SCOPE = Object.freeze({ name: '@ultimat3/core' });

export interface OtlpPostOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Never throws and never rejects. Telemetry delivery is not the request: a collector that is down
 * must not become the app's outage, and the alternative — an unhandled rejection from a `void`ed
 * promise — takes the process with it on Bun.
 */
export async function postOtlp(options: OtlpPostOptions): Promise<void> {
  try {
    const response = await options.fetch(options.url, {
      method: 'POST',
      headers: { ...options.headers },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      logger.warn('otlp export rejected', { url: options.url, status: response.status });
    }
  } catch (failure) {
    logger.warn('otlp export failed', {
      url: options.url,
      // `renderThrowable`: the read that renders a caught value must not itself throw, or the
      // export failure this catch exists to swallow escapes as an unhandled rejection.
      error: renderThrowable(failure),
    });
  }
}
