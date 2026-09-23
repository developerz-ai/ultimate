// `realtime.enabled`, obeyed where the roles are chosen. Until 22.0.0 no boot read it: `x dev`
// started a `sync` node and `ROLE=sync` served one whatever the key said, so `enabled: false` was
// documentation. Off now means no `sync` node, no replicator and — with no node to feed — no live
// feed wiring (`runtime-live-feed.ts` starts nothing for a null node).

import type { RealtimeConfig, Role } from '@ultimat3/core';
import { ConfigInvalidError, logger } from '@ultimat3/core';

/** The roles that exist only to serve realtime. `web` publishes too, but serves pages first. */
const REALTIME_ROLES: readonly Role[] = ['sync', 'replicator'];

/**
 * The roles this process may start. Disabled drops the realtime roles and keeps the rest, which is
 * what `x dev`'s default set needs on an app that opted out (`enabled: false`; the default is on).
 * A selection that was NOTHING but realtime roles is refused instead: that is `ROLE=sync` on an app
 * that turned realtime off, a container that would bind nothing and restart behind its probe.
 */
export function rolesUnderRealtime(
  selected: readonly Role[],
  realtime: Pick<RealtimeConfig, 'enabled'>,
): readonly Role[] {
  // The key is read only when a realtime role was asked for, so a selection without one never
  // depends on it — a hand-built runtime in a test that starts `web` alone included.
  const dropped = selected.filter((role) => REALTIME_ROLES.includes(role));
  if (dropped.length === 0 || realtime.enabled) return selected;
  const kept = selected.filter((role) => !REALTIME_ROLES.includes(role));
  if (kept.length === 0) {
    throw new ConfigInvalidError({
      cause: `role ${dropped.join(',')} was asked for and realtime.enabled is false in app.config.ts, so this process would serve nothing`,
      fix: `set realtime: { enabled: true } in app.config.ts, or run a role that is not realtime: x dev --role web,worker,scheduler`,
      meta: { key: 'realtime.enabled', roles: dropped },
    });
  }
  logger.info(`realtime.enabled is false in app.config.ts: not starting ${dropped.join(', ')}`);
  return kept;
}
