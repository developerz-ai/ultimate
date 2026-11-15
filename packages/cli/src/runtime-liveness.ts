// Single responsibility: the LIVENESS answer of the roles whose only socket is the scrape port —
// `worker`, `scheduler`, `replicator`. Core's `/healthz` (503 once stopped) plus every running
// loop's heartbeat (`@ultimat3/jobs`' `staleLoops`): a loop past its bound is a wedged process
// the kubelet must restart, even while its event loop still answers every scrape.

import { type HealthPayload, healthzPayload, logger } from '@ultimat3/core';
import { staleLoops } from '@ultimat3/jobs';

/**
 * `/healthz` on `METRICS_PORT`. The answer carries no loop name — that port is unauthenticated and
 * names are topology — so the log line is where an operator reads which loop, why and how long.
 * `/readyz` never reads loops: a wedge is a restart, never a traffic decision.
 */
export function livenessPayload(): HealthPayload {
  const health = healthzPayload();
  if (!health.ok) return health;
  const stale = staleLoops();
  if (stale.length === 0) return health;
  logger.error('ultimate.liveness.loop-stale', {
    loops: stale.map((loop) => `${loop.name} ${loop.reason} ${loop.ageMs}ms > ${loop.boundMs}ms`),
  });
  return { ok: false, status: 503, body: health.body };
}
