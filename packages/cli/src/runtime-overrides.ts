// The one place a host hands the framework a driver. `ServeOptions` had `{ root, env, role, port,
// metricsPort }` and nothing else, so the ONLY way to install a driver was to call an ambient
// setter from an app module — which `loadApp` imports *after* `startServices` has already captured
// its own. This type is the seam that removes the need to, and every field is read exactly once,
// as the first arm of `overrides?.x ?? <the env-selected default>`.

import type { PurgeDriver } from '@ultimat3/cache';
import type { Middleware, RateLimitStore } from '@ultimat3/http';
import type { JobDriver } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import type { SyncAuthenticator, Transport } from '@ultimat3/realtime';
import type { IsrStore } from '@ultimat3/render';
import type { ImageTransformDriver } from '@ultimat3/seo';
import type { Storage } from '@ultimat3/storage';

/**
 * What a deployment may substitute for a boot decision the environment would otherwise make.
 *
 * Every field is OPTIONAL and every field REPLACES the default rather than sitting beside it: the
 * env switch each one used to be is now the `??` arm of one expression, so there is exactly one
 * answer to "which driver is this process running" (axiom 1). A field nothing consumes is not
 * here — the entity `Driver` in particular, because `@ultimat3/entity` exposes no installer for
 * one (`database(entities, { driver })` is the app's own call), and a slot the boot cannot honour
 * is the class of defect this seam exists to end.
 */
export interface RuntimeOverrides {
  /**
   * The queue every enqueue AND every claim uses. Installed as the ambient driver too, so
   * `jobDriver()` and the worker cannot disagree — `startRoles` refuses to boot when they do.
   */
  readonly jobs?: JobDriver;
  /** Replaces the `S3_ENDPOINT`/embedded-disk decision whole: disks, default disk and all. */
  readonly storage?: Storage;
  /** Replaces the `SMTP_URL` / `RESEND_API_KEY` selection. */
  readonly mail?: MailDriver;
  /**
   * Replaces the `NATS_URL` selection. Already connected when it arrives, and NOT closed by
   * `stop()`: whoever built it owns its socket, exactly as `createServer` does not close a
   * `rateLimitStore` it was handed.
   */
  readonly transport?: Transport;
  /** Replaces the `CLOUDFLARE_*` / `FASTLY_*` selection behind the `cdn` cache tier. */
  readonly purge?: PurgeDriver;
  /**
   * Where the HTTP rate limiter keeps its counters. It also DECIDES `rateLimit.scope`: a store
   * that says `'shared'` is a deployment declaring fleet-wide numbers, and `assertRateLimitScope`
   * holds the two halves together rather than a literal in the boot contradicting the store.
   */
  readonly rateLimitStore?: RateLimitStore;
  /**
   * Where regenerated ISR pages live. Omitted, `createIsrController` keeps a per-process memory
   * store — twelve replicas then hold twelve of them, and a purge tag reaches one twelfth of the
   * fleet.
   */
  readonly isrStore?: IsrStore;
  /** Prepended to the pipeline by `createServer`, which `startRoles` never passed one. */
  readonly middleware?: readonly Middleware[];
  /** The `/media/*` transform. Omitted, `builtinImageDriver` — core's PNG/JPEG pipeline. */
  readonly images?: ImageTransformDriver;
  /**
   * Who is dialling the `sync` node. Omitted, the app's own `configureAuthenticator()` is adapted
   * — this field exists because that adapter can only ever answer `{ actor }`, and a real
   * deployment's token has an `expiresAt` and a `refresh`, which is the whole of re-authorization.
   */
  readonly syncAuthenticate?: SyncAuthenticator;
}
