// The app's own HTTP declaration, and the layering that keeps a boot fact above it. One
// registration site, read once by whatever process starts the web role — the same seam
// `configureAuthenticator()` is, and for the same reason: `@ultimat3/core` is tier 0 and cannot
// hold this package's types, so an `http` block on `AppConfig` would be a second declaration of
// `HttpConfigInput` in a package that can never check it against this one.

import type { HttpConfigInput } from './config';
import type { RateLimitConfig } from './rate-limit';

/**
 * The keys the BOOT owns, and the reason this type is an `Omit` rather than a hand-written list of
 * what an app may say. Each of these is a fact about the PROCESS — the port it was told to bind,
 * the build it serves, whether it is `x dev`, how many proxies the deployment puts in front of it,
 * `auth.signInPath` from `app.config.ts` — so a value an app wrote for one of them would be
 * overwritten at every boot: a switch with no wire, which is the defect this whole surface exists
 * to remove. Refused at the type level, which is the build error that enforces it.
 */
export type BootOwnedHttpKey =
  | 'port'
  | 'hostname'
  | 'dev'
  | 'buildId'
  | 'signInPath'
  | 'trustProxy'
  | 'trustedProxyHops';

/**
 * What an app declares. `rateLimit.scope` is boot-owned for the same reason as the keys above:
 * `startWeb` DERIVES it from the store it installed, so a literal here would be a second
 * declaration quietly contradicting the object beside it — and `assertRateLimitScope` compares
 * exactly those two halves.
 */
export type AppHttpConfig = Omit<HttpConfigInput, BootOwnedHttpKey | 'rateLimit'> & {
  readonly rateLimit?: Omit<Partial<RateLimitConfig>, 'scope'> | undefined;
};

/**
 * The app's declaration, if it made one. A single value and not a list, exactly as
 * `configuredAuthenticator` is: two answers to "how does this server bind and what does it admit"
 * is two configurations, and the one that ran first wins.
 *
 * Process-global for the reason that one is: the app has exactly one boot, and every host that
 * starts a server (`x dev`, `apps/web/server.ts`) would otherwise need its own way to be handed
 * the same values — which is what left the whole tuning surface unreachable, since the only
 * shipped construction was a fixed literal inside the CLI.
 */
let declared: AppHttpConfig | undefined;

export const configureHttp = (config: AppHttpConfig): void => {
  declared = config;
};

/** What the boot layers its own facts over. `undefined` means the locked defaults stand. */
export const configuredHttp = (): AppHttpConfig | undefined => declared;

/** Test seam. Production configures once at module scope and never unconfigures. */
export const resetHttpConfig = (): void => {
  declared = undefined;
};

type SecurityInput = NonNullable<HttpConfigInput['security']>;
type CspInput = NonNullable<SecurityInput['csp']>;
type CspExtend = NonNullable<CspInput['extend']>;

/**
 * Per directive, both lists. The app's `script-src` is a CDN it serves scripts from and the boot's
 * is the sha256 of the hydration runtime this process emits inline — each is the whole answer for
 * something, so a merge that let either win breaks a page: the CDN script, or every island.
 *
 * Built through a `Map`, never by assigning `out[directive]`: a directive named `__proto__` sets
 * the PROTOTYPE rather than a key, which is a source silently dropped from the one header this
 * package locks down hardest.
 */
const mergeCspExtend = (
  app: CspExtend | undefined,
  boot: CspExtend | undefined,
): CspExtend | undefined => {
  if (app === undefined) return boot;
  if (boot === undefined) return app;
  const merged = new Map<string, readonly string[]>(Object.entries(app));
  for (const [directive, sources] of Object.entries(boot)) {
    merged.set(directive, [...(merged.get(directive) ?? []), ...sources]);
  }
  return Object.fromEntries(merged);
};

const mergeSecurity = (
  app: SecurityInput | undefined,
  boot: SecurityInput | undefined,
): SecurityInput | undefined => {
  if (app === undefined) return boot;
  if (boot === undefined) return app;
  const extend = mergeCspExtend(app.csp?.extend, boot.csp?.extend);
  const csp: CspInput = {
    ...app.csp,
    ...boot.csp,
    ...(extend === undefined ? {} : { extend }),
  };
  return { ...app, ...boot, csp };
};

/**
 * The app's declaration with the boot's own facts laid OVER it — the one order that can be right.
 * `buildId`, the port, the CSP hashes of what this process emits and the scope of the store it
 * installed are all things the boot measured; an app can only have guessed at them. Everything
 * else the app said survives, which is the whole point of it having said anything.
 *
 * Sections merge one level down rather than being replaced whole: `security: { csp: { extend } }`
 * from the boot would otherwise delete an app's `hsts`, `frameAncestors` and its own extends, and
 * `rateLimit: { scope }` would delete every bucket it declared.
 */
export const mergeHttpConfig = (
  app: AppHttpConfig | undefined,
  boot: HttpConfigInput,
): HttpConfigInput => {
  if (app === undefined) return boot;
  // `rateLimit` is lifted out of the spread rather than overwritten by it: `AppHttpConfig` types
  // it WITHOUT `scope` and `HttpConfigInput` types it with, so under `exactOptionalPropertyTypes`
  // the spread of the narrower optional is not assignable to the wider one. The merged value is
  // computed below and put back.
  const { rateLimit: appRateLimit, ...appRest } = app;
  const cors =
    app.cors === undefined && boot.cors === undefined ? undefined : { ...app.cors, ...boot.cors };
  const csrf =
    app.csrf === undefined && boot.csrf === undefined ? undefined : { ...app.csrf, ...boot.csrf };
  const locale =
    app.locale === undefined && boot.locale === undefined
      ? undefined
      : { ...app.locale, ...boot.locale };
  const tz = app.tz === undefined && boot.tz === undefined ? undefined : { ...app.tz, ...boot.tz };
  const rateLimit: Partial<RateLimitConfig> | undefined =
    appRateLimit === undefined && boot.rateLimit === undefined
      ? undefined
      : { ...appRateLimit, ...boot.rateLimit };
  const security = mergeSecurity(app.security, boot.security);
  return {
    ...appRest,
    ...boot,
    ...(cors === undefined ? {} : { cors }),
    ...(csrf === undefined ? {} : { csrf }),
    ...(locale === undefined ? {} : { locale }),
    ...(tz === undefined ? {} : { tz }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(security === undefined ? {} : { security }),
  };
};
