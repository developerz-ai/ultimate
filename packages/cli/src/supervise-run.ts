// The supervisor at work: `METRICS_PORT` opened for the whole container first, then the children,
// until they are gone — answering the container's exit code. Loaded by `runRole` only when the
// resolved count is more than one, so a lone process never evaluates it.

import type { Role } from '@ultimat3/core';
import { drainDeadlineMs, readinessGraceMs } from '@ultimat3/core';
import { containerBinding, metricsPortFor, portFromEnv } from './serve-env';
import type { ServeOptions } from './serve-types';
import type { SuperviseInput, Supervisor, SupervisorView } from './supervise';
import { supervise } from './supervise';
import { containerPool } from './supervise-pool';
import { childHealthy, startSupervisorProbe } from './supervise-probe';

/** The process seams `supervise()` defaults to the real ones: a test hands in fakes. */
export type SupervisedSeams = Pick<SuperviseInput, 'spawn' | 'signals' | 'timers'>;

/** Runs `count.count` children of this very entry point; answers the container's exit code. */
export async function runSupervised(
  options: ServeOptions,
  role: Role,
  count: number,
  seams: SupervisedSeams = {},
): Promise<number> {
  let supervisor: Supervisor | undefined;
  const view: SupervisorView = {
    children: () => supervisor?.view.children() ?? [],
    ready: () => supervisor?.view.ready() ?? false,
    live: () => supervisor?.view.live() ?? true,
  };
  const port = options.port ?? portFromEnv(options.env);
  // FIRST, as a lone process opens its own: the platform's probes find a socket from the start.
  const probe = startSupervisorProbe({
    port: metricsPortFor(options.env, port, options.metricsPort),
    hostname: containerBinding(options.env, options.hostname).hostname,
    role,
    view,
  });
  try {
    supervisor = supervise({
      ...seams,
      count,
      role,
      // The role this process resolved, whatever `options.role` overrode: a child re-reads `ROLE`.
      env: { ...options.env, ROLE: role },
      pool: containerPool(options, role),
      // Until each child reports its own: the framework default, which an app may only raise.
      budgetMs: readinessGraceMs() + drainDeadlineMs(),
      healthy: childHealthy,
    });
    return await supervisor.done;
  } finally {
    probe.stop();
  }
}
