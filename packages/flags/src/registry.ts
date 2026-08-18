// Single responsibility: the declared set of flags for this process — the one place a key resolves
// to a `Flag`. Process-global and filled at import time, exactly like the error-code registry, so
// evaluation is a map lookup rather than a load.

import { flagDuplicate, flagUnknown } from './errors';
import type { Flag, FlagDef } from './flag';
import { toFlag, withTargeting } from './flag';
import { assertTargeting, type FlagTargeting } from './targeting';

const flags = new Map<string, Flag>();

/**
 * The one call an app makes to declare a flag. A `define*` helper, deliberately NOT a ninth
 * primitive: a flag is a declaration plus a pure predicate, it has no handler, no schema and no
 * surface of its own — the same shape as `defineRoles` and `defineCatalogs`.
 */
export function defineFlag(def: FlagDef): Flag {
  const flag = toFlag(def);
  if (flags.has(flag.key)) throw flagDuplicate(flag.key);
  flags.set(flag.key, flag);
  return flag;
}

/**
 * Throws rather than answering `false` for an unknown key. A typo that reads as "off" is the
 * failure mode a flag system exists to have: the branch silently never runs, in production, and
 * nothing anywhere says so.
 */
export function flagFor(key: string): Flag {
  const flag = flags.get(key);
  if (flag === undefined) throw flagUnknown(key, [...flags.keys()]);
  return flag;
}

export const hasFlag = (key: string): boolean => flags.has(key);

/** Sorted by key — the projection and the manifest both need a stable order. */
export const allFlags = (): readonly Flag[] =>
  [...flags.values()].sort((a, b) => a.key.localeCompare(b.key));

export interface SnapshotResult {
  /** Keys whose targeting was replaced. */
  readonly applied: readonly string[];
  /** Keys the store carried that this build does not declare. */
  readonly unknown: readonly string[];
}

/**
 * Land a store's targeting on the declared flags. This is the out-of-band half that keeps
 * `isEnabled()` synchronous: a poller, a job or a realtime channel calls this, and evaluation
 * never awaits anything.
 *
 * Unknown keys are reported, not thrown: a control plane is routinely ahead of a deploy, and a
 * kill switch that refuses to land because the payload also mentioned tomorrow's flag is a kill
 * switch that does not work on the day it is needed. A bad *targeting* still throws — landing a
 * `rollout: 0.5` would silently switch a feature off for everyone.
 *
 * **Two passes, because the throw above is only worth anything if nothing landed.** Validating and
 * writing in one loop retargeted every key ahead of the bad one and then threw, so the caller — a
 * poller, a job or a realtime channel — saw a failure and had no record that half the fleet's
 * flags had already moved. Nothing here awaits, so no other code observes the gap between passes.
 */
export function applyFlagSnapshot(
  snapshot: Readonly<Record<string, FlagTargeting>>,
): SnapshotResult {
  const declared: [string, Flag, FlagTargeting][] = [];
  const unknown: string[] = [];
  for (const [key, targeting] of Object.entries(snapshot)) {
    const flag = flags.get(key);
    if (flag === undefined) {
      unknown.push(key);
      continue;
    }
    assertTargeting(key, targeting);
    declared.push([key, flag, targeting]);
  }
  const applied: string[] = [];
  for (const [key, flag, targeting] of declared) {
    flags.set(key, withTargeting(flag, targeting));
    applied.push(key);
  }
  return { applied, unknown };
}

/** Test-only. Production declares once at import and never withdraws. */
export function resetFlags(): void {
  flags.clear();
}
