// The shapes a production boot takes and answers. Split from `serve.ts`, which re-exports them.

import type { Role } from '@ultimat3/core';
import type { DriftReport, MigrationReport } from '@ultimat3/db';
import type { RunningRoles } from './role-start';
import type { Env } from './runtime-bindings';
import type { RuntimeOverrides } from './runtime-overrides';
import type { RunningServices } from './runtime-services';

export interface ServeOptions {
  readonly root: string;
  readonly env: Env;
  /** Overrides `ROLE`; `runRole` reads the environment when this is absent. */
  readonly role?: Role;
  /** Overrides `PORT`. 0 asks the kernel for an ephemeral one, which is what a test wants. */
  readonly port?: number;
  /** Overrides `METRICS_PORT`, on the same terms. */
  readonly metricsPort?: number;
  /**
   * Overrides `HOST`: the interface the HTTP roles bind. An app that must never answer on a public
   * interface passes `'127.0.0.1'` here rather than trusting the deployment to set the variable.
   */
  readonly hostname?: string;
  /**
   * The drivers this deployment supplies instead of the ones the environment would select.
   *
   * This field is why `apps/web/server.ts` can stay three lines and still run a custom queue, a
   * shared ISR store or an app's own middleware. Before it there was nowhere to hand the framework
   * a driver, so the only way was an ambient setter from an app module — which `loadApp` imports
   * AFTER `startServices` has captured its own, giving a process that enqueues to one queue and
   * claims from another. `startRoles` now refuses that split outright.
   */
  readonly runtime?: RuntimeOverrides;
}

export interface ServedApp {
  readonly kind: 'served';
  readonly role: Role;
  /** `http://…` for the web role; null for the roles that open no HTTP socket. */
  readonly url: string | null;
  readonly buildId: string;
  readonly running: RunningRoles;
  readonly runtime: RunningServices;
  stop(): Promise<void>;
}

export interface MigratedApp {
  readonly kind: 'migrated';
  readonly role: 'migrate';
  readonly report: MigrationReport;
  /** The post-condition: the live schema against the ledger this run just wrote. */
  readonly drift: DriftReport;
}

export type StartedApp = ServedApp | MigratedApp;
