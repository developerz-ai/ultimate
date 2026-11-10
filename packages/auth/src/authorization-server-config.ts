// Single responsibility: what `authorizationServer()` is configured with, screened once at
// construction into the resolved form every grant reads. A bad field is `X_AUTH_SERVER_INVALID`
// naming it — at boot, never on the first token request a partner makes.

import type { Clock } from '@ultimat3/core';
import { liveClock, renderCauseValue } from '@ultimat3/core';
import type { DialResolve, OutboundFetch } from '@ultimat3/core/outbound';
import { installedAuthServerStore } from './authorization-server-installed';
import type { AuthServerStore } from './authorization-server-store';
import type { AuthServerGrant } from './authorization-server-types';
import { DEVICE_GRANT } from './authorization-server-types';
import { AuthError } from './errors';
import { type AuthLimiter, memoryAuthLimiter } from './rate-limit';

export interface AuthServerLifetimes {
  /** Access-token life. Short: an access token is not revocable faster than a lookup. */
  readonly accessSeconds: number;
  /** A refresh token unused this long is dead. The app's retention window. */
  readonly refreshIdleDays: number;
  /** Required once `client_credentials` is enabled: a machine's token life. */
  readonly clientSeconds?: number | undefined;
  /** Device-code life. Defaults to 600, RFC 8628's own example. */
  readonly deviceSeconds?: number | undefined;
}

/** One line per decision the server made — the wrapper turns these into `mcp.auth.*`. */
export interface AuthServerEvent {
  readonly kind:
    | 'issued'
    | 'refused'
    | 'code-replayed'
    | 'refresh-replayed'
    | 'revoked'
    | 'grant-disabled';
  /** The RFC 6749 `error` the wire answered, on a refusal. */
  readonly error?: string | undefined;
  readonly clientId?: string | undefined;
  readonly grantType?: string | undefined;
}

export interface AuthorizationServerOptions {
  /** RFC 8414 issuer: https (http only on loopback), no query, no fragment. */
  readonly issuer: string;
  /**
   * Where clients, codes, grants and tokens live. Omitted: the `authServerStore` port — what
   * `runtime.ts` installed, else Postgres over the app's pool (`installedAuthServerStore`).
   */
  readonly store?: AuthServerStore | undefined;
  /** The app's consent PAGE: the advertised `authorization_endpoint`. */
  readonly consentPath: string;
  readonly lifetimes: AuthServerLifetimes;
  /** Every scope this server may grant. A client and a person only ever narrow it. */
  readonly scopes: readonly string[];
  /**
   * RFC 8707 resource indicators this server mints for. A request naming any other is
   * `invalid_target`; one naming none gets an unbound grant, which a binding resolver refuses.
   */
  readonly resources?: readonly string[] | undefined;
  /** The resource a request naming none is bound to. Must be one of `resources`. */
  readonly defaultResource?: string | undefined;
  /** `'metadata-document'` (default): https client ids are fetched. `'dynamic'` adds RFC 7591. */
  readonly registration?: 'metadata-document' | 'dynamic' | undefined;
  /** Defaults to `['authorization_code', 'refresh_token']`. Each further grant is named. */
  readonly grants?: readonly AuthServerGrant[] | undefined;
  /** The app's device verification PAGE. Required once the device grant is enabled. */
  readonly devicePath?: string | undefined;
  readonly clock?: Clock | undefined;
  /** Counts registrations and user-code guesses per caller key. Defaults to per-process memory. */
  readonly limiter?: AuthLimiter | undefined;
  /** How metadata documents are fetched — injected by a test; production dials the internet. */
  readonly fetch?: OutboundFetch | undefined;
  readonly resolveHost?: DialResolve | undefined;
  readonly onEvent?: ((event: AuthServerEvent) => void) | undefined;
}

export interface ResolvedAuthServerConfig {
  readonly issuer: string;
  /** The issuer's path, `''` at the root: every endpoint mounts under it. */
  readonly basePath: string;
  readonly origin: string;
  readonly store: AuthServerStore;
  readonly consentPath: string;
  readonly devicePath: string | null;
  readonly accessSeconds: number;
  readonly refreshIdleMs: number;
  readonly clientSeconds: number | null;
  readonly deviceSeconds: number;
  readonly scopes: ReadonlySet<string>;
  readonly resources: ReadonlySet<string>;
  readonly defaultResource: string | null;
  readonly dynamic: boolean;
  readonly grants: ReadonlySet<AuthServerGrant>;
  readonly clock: Clock;
  readonly limiter: AuthLimiter;
  readonly fetch: OutboundFetch | undefined;
  readonly resolveHost: DialResolve | undefined;
  readonly emit: (event: AuthServerEvent) => void;
}

const KNOWN_GRANTS: ReadonlySet<string> = new Set<AuthServerGrant>([
  'authorization_code',
  'refresh_token',
  'client_credentials',
  DEVICE_GRANT,
]);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PAGE_PATH = /^\/[A-Za-z0-9\-._~/]*$/;
/** RFC 6749 §3.3 scope-token. */
export const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const invalid = (field: string, why: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_SERVER_INVALID',
    cause: `authorizationServer({ ${field} }) ${why}`,
    fix,
    meta: { field },
  });

/** A lifetime: a whole number of at least 1, so `NaN` and `Infinity` are refused, never stored. */
const lifetimeSeconds = (field: string, value: number | undefined): number => {
  if (value !== undefined && Number.isSafeInteger(value) && value >= 1) return value;
  throw invalid(
    field,
    `is ${renderCauseValue(value)}, not a whole number of at least 1`,
    `authorizationServer({ lifetimes: { ${field.replace('lifetimes.', '')}: 600 } })   # a positive whole number`,
  );
};

const pagePath = (field: string, value: string): string => {
  if (PAGE_PATH.test(value) && !value.includes('//')) return value;
  throw invalid(
    field,
    `is ${renderCauseValue(value)}, not an absolute path on the issuer's origin`,
    `authorizationServer({ ${field}: '/oauth/consent' })   # the path of the app's own page`,
  );
};

function issuerUrl(value: string): URL {
  const url = URL.parse(value);
  const secure =
    url !== null &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  if (url !== null && secure && url.search === '' && url.hash === '' && !value.endsWith('/')) {
    return url;
  }
  throw invalid(
    'issuer',
    `is ${renderCauseValue(value)}; RFC 8414 needs https (http only on loopback), no query, no fragment, no trailing slash`,
    "authorizationServer({ issuer: 'https://www.example.com' })   # the app's public origin",
  );
}

/** RFC 8707 §2: an absolute URI with no fragment. */
function resourceIndicator(value: string): string {
  const url = URL.parse(value);
  if (url !== null && url.hash === '' && !value.includes('#')) return value;
  throw invalid(
    'resources',
    `holds ${renderCauseValue(value)}, not an absolute URI without a fragment`,
    "authorizationServer({ resources: ['https://www.example.com/mcp'] })   # canonical URLs, no fragment",
  );
}

function defaultResourceOf(options: AuthorizationServerOptions): string | null {
  const fallback = options.defaultResource;
  if (fallback === undefined) return null;
  if ((options.resources ?? []).includes(fallback)) return fallback;
  throw invalid(
    'defaultResource',
    `is ${renderCauseValue(fallback)}, which is not one of resources`,
    'authorizationServer({ resources: [defaultResource], defaultResource })   # or drop defaultResource',
  );
}

export function resolveAuthServerConfig(
  options: AuthorizationServerOptions,
): ResolvedAuthServerConfig {
  const url = issuerUrl(options.issuer);
  const grants = new Set<AuthServerGrant>(
    options.grants ?? ['authorization_code', 'refresh_token'],
  );
  for (const grant of grants) {
    if (!KNOWN_GRANTS.has(grant)) {
      throw invalid(
        'grants',
        `names ${renderCauseValue(grant)}, which this server does not implement`,
        `authorizationServer({ grants: [${[...KNOWN_GRANTS].map((g) => `'${g}'`).join(', ')}] })   # only these are implemented`,
      );
    }
  }
  for (const scope of options.scopes) {
    if (!SCOPE_TOKEN.test(scope)) {
      throw invalid(
        'scopes',
        `holds ${renderCauseValue(scope)}, not an RFC 6749 scope-token`,
        "authorizationServer({ scopes: ['cases:read'] })   # printable ASCII, no space, quote or backslash",
      );
    }
  }
  const lifetimes = options.lifetimes;
  const device = grants.has(DEVICE_GRANT);
  if (device && options.devicePath === undefined) {
    throw invalid(
      'devicePath',
      'is missing while the device grant is enabled, so verification_uri would name no page',
      "authorizationServer({ grants, devicePath: '/oauth/device' })   # the app's verification page",
    );
  }
  const clock = options.clock ?? liveClock;
  return {
    issuer: options.issuer,
    basePath: url.pathname === '/' ? '' : url.pathname,
    origin: url.origin,
    // A getter, read per call: `runtime.ts` may import the module that builds this server BEFORE
    // the boot installs `runtime.authServerStore`, and a captured default would ignore it.
    get store(): AuthServerStore {
      return options.store ?? installedAuthServerStore();
    },
    consentPath: pagePath('consentPath', options.consentPath),
    devicePath:
      options.devicePath === undefined ? null : pagePath('devicePath', options.devicePath),
    accessSeconds: lifetimeSeconds('lifetimes.accessSeconds', lifetimes.accessSeconds),
    refreshIdleMs: lifetimeSeconds('lifetimes.refreshIdleDays', lifetimes.refreshIdleDays) * DAY_MS,
    clientSeconds: grants.has('client_credentials')
      ? lifetimeSeconds('lifetimes.clientSeconds', lifetimes.clientSeconds)
      : null,
    deviceSeconds: lifetimeSeconds('lifetimes.deviceSeconds', lifetimes.deviceSeconds ?? 600),
    scopes: new Set(options.scopes),
    resources: new Set((options.resources ?? []).map(resourceIndicator)),
    defaultResource: defaultResourceOf(options),
    dynamic: options.registration === 'dynamic',
    grants,
    clock,
    limiter:
      options.limiter ??
      memoryAuthLimiter(clock, {
        maxAttempts: 10,
        windowMs: 60_000,
        lockoutMs: 60_000,
        scope: 'process',
      }),
    fetch: options.fetch,
    resolveHost: options.resolveHost,
    emit: options.onEvent ?? (() => {}),
  };
}
