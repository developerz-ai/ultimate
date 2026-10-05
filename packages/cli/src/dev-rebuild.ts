// The `x dev` reload: one save in, the manifest, the findings and the island bundles rebuilt as
// one generation, the ISR store emptied, and a save this process cannot serve handed to the
// supervisor as a restart. Coalesced, so a tick arriving mid-build is one trailing rebuild.

import type { Manifest } from '@ultimat3/manifest';
import type { IsrController } from '@ultimat3/render/server';
import { appManifest } from './app-manifest';
import type { StalePin } from './app-reload-graph';
import { takeStalePins } from './app-reload-graph';
import type { ReloadTrigger } from './dev-reload';
import { coalesceReloads } from './dev-reload';
import { restartFinding } from './dev-supervisor';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import type { Finding } from './output';
import { findingFrom } from './output';

export interface DevState {
  manifest: Manifest;
  reloads: number;
  /** A save that will not build. Replaced on every attempt, so a fixed file clears it. */
  reloadFinding: Finding | undefined;
  /**
   * Modules that would not import and primitives that would not register, as of the LAST scan —
   * the boot's, then each rebuild's. A page saved with a syntax error is a finding here until the
   * save that fixes it, and the boot's list alone would never show it.
   */
  appFindings: readonly Finding[];
  /**
   * The client entries, rebuilt on the same tick as the manifest. An island is the one module this
   * process never imports, so a fresh `Bun.build` is the whole of its reload. The route module
   * beside it is re-imported by that same scan (`app-load.ts`) — the two are one generation, or
   * a save serves a new island under an old page, which is what it did until 2026-09-07.
   */
  islands: IslandBundle;
}

/** What a rebuild reports to, read off `StartDevOptions`. */
export interface DevRebuildOptions {
  readonly root: string;
  readonly onReload?: (file: string, durationMs: number) => void;
  readonly onRestart?: (pins: readonly StalePin[]) => void;
}

/** The watcher's `onChange`: rebuild `state` for the saved `file`, never rejecting. */
export function devRebuilder(
  options: DevRebuildOptions,
  state: DevState,
  isr: IsrController,
): ReloadTrigger {
  // One rebuild at a time, and the last save wins: a tick arriving mid-build coalesces into ONE
  // trailing rebuild instead of racing the one in flight for `state.manifest` and `state.islands`.
  return coalesceReloads(
    async (file) => {
      const started = performance.now();
      const [{ manifest, findings }, islands] = await Promise.all([
        appManifest(options.root),
        buildIslands(options.root),
      ]);
      state.manifest = manifest;
      state.appFindings = findings;
      state.islands = islands;
      for (const path of isr.store().paths()) isr.store().delete(path);
      state.reloads += 1;
      // Read on EVERY rebuild, so a pin one save reached is never reported against the next save.
      const pins = takeStalePins();
      state.reloadFinding =
        pins.length > 0 && options.onRestart === undefined
          ? restartFinding(options.root, pins)
          : undefined;
      if (pins.length > 0 && options.onRestart !== undefined) options.onRestart(pins);
      else options.onReload?.(file, Math.round(performance.now() - started));
    },
    // Same rule as a module that will not import: a save the manifest cannot be rebuilt from is
    // a finding on `/_x`, never an unhandled rejection that takes the dev server down.
    (error: unknown, file: string) => {
      state.reloadFinding = { ...findingFrom(error), at: file };
    },
  );
}
