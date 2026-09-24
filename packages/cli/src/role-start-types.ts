// The options `startRoles` takes and what it answers. Split from `role-start.ts` at its line
// ceiling; `role-start.ts` re-exports both, so every importer keeps its path.

import type { DrainConfig, Role } from '@ultimat3/core';
import type { Route, ServerHandle, ServerHooks } from '@ultimat3/http';
import type { Scheduler, Worker } from '@ultimat3/jobs';
import type { LiveQueryRegistry, LiveReplicator } from '@ultimat3/realtime/server';
import type { MetricsEndpoint } from './metrics-endpoint';
import type { RunningReplicator } from './role-replicator';
import type { Env } from './runtime-bindings';
import type { LiveFeed } from './runtime-live-feed';
import type { RuntimeOverrides } from './runtime-overrides';
import type { RunningServices } from './runtime-services';
import type { WebBinding } from './web-binding';

/** The roles `x dev` starts when `--role` names none, in boot order. */
export const DEV_ROLES: readonly Role[] = ['web', 'sync', 'worker', 'scheduler'];

export interface StartRolesOptions {
  readonly roles: readonly Role[];
  readonly port: number;
  readonly buildId: string;
  readonly runtime: RunningServices;
  /** Routes the web role serves: `/_x`, the actions, the pages. */
  readonly routes: readonly Route[];
  /** The process environment, for the roles that resolve a driver from it. */
  readonly env: Env;
  /**
   * How the web role binds and what it admits about itself. `x dev` keeps the default —
   * loopback, `dev: true`, so a laptop on a café network is not serving the app to the café. A
   * container passes `{ dev: false, hostname: '0.0.0.0' }`: a process bound to `localhost` inside
   * a container is unreachable from the port mapping, the load balancer and every PaaS health
   * probe, which is the same failure in four costumes.
   */
  readonly http?: WebBinding;
  /**
   * The app's `auth.signInPath`. Threaded rather than read from the config here because
   * `startRoles` takes plain values — a test starts a web role with no `app.config.ts` at all.
   */
  readonly signInPath?: string | null;
  /**
   * The app root, for the one seam that is a FILE and not a value: `apps/web/site/errors/404.html`
   * and its siblings. Bound HERE rather than passed by each caller, because `x dev` and `serve.ts`
   * both boot through this function and an override wired at one of them alone is a page that
   * appears in dev and not in production — `/favicon.ico`'s rule, one seam over.
   *
   * Optional for the reason `signInPath` is: `startRoles` takes plain values, and a test starts a
   * web role with no app on disk at all. Absent, every error page is the framework's.
   */
  readonly root?: string;
  /**
   * Inline `<style>` bodies this process serves that the app's own surfaces do not account for —
   * `/_x`'s shell. The surfaces themselves are read from the stylesheet registry here rather than
   * passed, so no caller of `startRoles` can ship a web server whose CSP blocks the pages it
   * serves: that policy is what rendered every deployed app completely unstyled.
   */
  readonly inlineStyles?: readonly string[];
  /** `script-src` sources beyond the hydration runtime's — the theme boot's hash. */
  readonly inlineScripts?: readonly string[];
  /**
   * Non-fatal findings the browser overlay shows next to an error, for the request being answered.
   * Only `x dev` supplies one — `serve.ts` boots through this same function and omits it, so a
   * production process never has a diagnostic to call (axiom 6).
   */
  readonly devNotices?: ServerHooks['devNotices'];
  /**
   * Where the scrape listener binds. Defaults to `DEFAULT_METRICS_PORT`, except when `port` is 0
   * — a caller asking the kernel for an ephemeral HTTP port is a test, and a test that grabbed
   * 9090 would fail the next one to run beside it.
   */
  readonly metricsPort?: number;
  /**
   * What the host substituted for a boot decision. Read here for the three seams that are not
   * services — the rate-limit store, the middleware chain and the sync authenticator — while the
   * drivers themselves arrive already resolved on `runtime`.
   */
  readonly overrides?: RuntimeOverrides;
  /**
   * `app.config.ts`'s `drain` section, for the web server — its readiness grace is how long
   * `/readyz` answers 503 before the listener closes. `serve.ts` passes it; absent, core's own
   * default stands.
   */
  readonly drain?: Partial<DrainConfig>;
  /**
   * A scrape listener the caller opened before its own boot work, adopted rather than bound twice:
   * `serve.ts` opens it before loading the app and building islands, so a cold pod answers
   * `/metrics` — and the chart's startup probe — while it boots. Stopped with the roles.
   */
  readonly metrics?: MetricsEndpoint;
}

export interface RunningRoles {
  readonly roles: readonly Role[];
  /** `http://…` once the web role is up; null when it was not selected. */
  readonly url: string | null;
  /** Where the sync role accepts websockets; null when it was not selected. */
  readonly syncUrl: string | null;
  /** `http://…` — the scrape base. Never null: every role publishes a signal worth scaling on. */
  readonly metricsUrl: string;
  readonly server: ServerHandle | null;
  readonly worker: Worker | null;
  readonly scheduler: Scheduler | null;
  /** The slot and feed this process holds; null when the replicator was not selected. */
  readonly replicator: RunningReplicator | null;
  /** What feeds the sync node: this process's own writes, the WAL decoder, or nothing. */
  readonly liveFeed: LiveFeed;
  /** The in-process bridge when `liveFeed` is `in-process`, so a test can await `settled()`. */
  readonly liveBridge: LiveReplicator | null;
  /** The sync node's registry, so a test can hold a real subscription; null without the role. */
  readonly liveRegistry: LiveQueryRegistry | null;
  stop(): Promise<void>;
}
