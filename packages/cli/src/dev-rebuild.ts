// The `x dev` reload: one save in, the manifest, the findings and the island bundles rebuilt as
// one generation, the ISR store emptied, and a save this process cannot serve handed to the
// supervisor as a restart. Coalesced, so a tick arriving mid-build is one trailing rebuild.

// why: Bun ships no path API; a restart's pins are absolute, the watcher's file is root-relative.
import { resolve } from 'node:path';

import type { Manifest } from '@ultimat3/manifest';
import { beginDeviceSocketGeneration } from '@ultimat3/realtime/server';
import type { IsrController } from '@ultimat3/render/server';
import type { AppManifest } from './app-manifest';
import { appManifest } from './app-manifest';
import type { StalePin } from './app-reload-graph';
import { takeStalePins } from './app-reload-graph';
import { remountFinding, remountLine, remountReason } from './dev-rebuild-remount';
import { schemaAheadFindings } from './dev-rebuild-schema';
import type { ReloadTrigger } from './dev-reload';
import { coalesceReloads } from './dev-reload';
import { restartFinding, restartReason } from './dev-supervisor';
import type { BuildIslandsOptions, IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { appPersistsRecords } from './island-realtime-state';
import { msg } from './messages';
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

/** The builders of one generation — the seam a test times them through. */
export interface GenerationBuilders {
  readonly manifest: (root: string) => Promise<AppManifest>;
  readonly islands: (root: string, options: BuildIslandsOptions) => Promise<IslandBundle>;
  /** Entities ahead of the migrations (`dev-rebuild-schema.ts`); asked once the load is clean. */
  readonly schema: (root: string) => Promise<readonly Finding[]>;
}

const BUILDERS: GenerationBuilders = {
  manifest: appManifest,
  islands: buildIslands,
  schema: schemaAheadFindings,
};

/**
 * One generation — the app's manifest and its island bundle — both builders started at once, at
 * the boot as on every save. The island build is Bun's bundler, off the JS thread, and the app
 * load is imports on it: one after the other, a 5,000-file app's boot paid ~4 s and ~12 s in sum
 * before its first 200 (`scripts/bench/results/boot-large-app.json`).
 */
export async function buildGeneration(
  root: string,
  build: GenerationBuilders = BUILDERS,
): Promise<AppManifest & { readonly islands: IslandBundle }> {
  const loaded = build.manifest(root);
  // The one answer the island build takes from the app — whether it persists records — read only
  // once the load has settled: before it the registry is empty, and every reader island would be
  // built as one that restores (`island-realtime.ts`). Only realtime groups wait for it.
  const persists = (): Promise<boolean | undefined> =>
    loaded.then(
      () => appPersistsRecords(),
      () => undefined,
    );
  // After the load, beside the island build: the hash reads the registry the load filled, and a
  // load with findings left it short — drift that is not there, so it is not asked.
  const schema = loaded.then(({ findings }) => (findings.length > 0 ? [] : build.schema(root)));
  const [{ manifest, findings }, islands, ahead] = await Promise.all([
    loaded,
    build.islands(root, { persists }),
    schema,
  ]);
  return { manifest, findings: [...findings, ...ahead], islands };
}

/** What a rebuild reports to, read off `StartDevOptions`. */
export interface DevRebuildOptions {
  readonly root: string;
  readonly onReload?: (file: string, durationMs: number) => void;
  /**
   * `line` is the restart's own reason, rendered — a pinned module, a changed surface or a load
   * finding that appeared or cleared — so the log never states one cause for another.
   */
  readonly onRestart?: (pins: readonly StalePin[], line: string) => void;
}

/**
 * A save that declared a `deviceSocket()` path the listener did not bind: Bun's websocket paths
 * are fixed when it starts, so only a new process serves it — `restartFinding`'s code and fix.
 */
export function unservedDeviceFinding(path: string, file: string): Finding {
  return {
    code: 'X_DEV_RESTART_REQUIRED',
    cause: `deviceSocket('${path}') was declared after x dev bound its listener, which serves only the device paths it booted with`,
    fix: 'x stop && x dev   # the listener binds its websocket paths once, at boot',
    at: file,
  };
}

/**
 * The watcher's `onChange`: rebuild `state` for the saved `file`, never rejecting. `refreshDevices`
 * is the running roles' (`RunningRoles.refreshDevices`): the rescan is a new device generation, so
 * a re-evaluated `deviceSocket()` replaces its path's old value instead of colliding with it.
 */
export function devRebuilder(
  options: DevRebuildOptions,
  state: DevState,
  isr: IsrController,
  refreshDevices: () => Promise<readonly string[]>,
): ReloadTrigger {
  // What the route table was built from: the boot's generation, for the life of this process. Each
  // save is compared with IT, not with the save before — a route added two saves ago is still a 404.
  const mounted = { manifest: state.manifest, findings: state.appFindings };
  // One rebuild at a time, and the last save wins: a tick arriving mid-build coalesces into ONE
  // trailing rebuild instead of racing the one in flight for `state.manifest` and `state.islands`.
  return coalesceReloads(
    async (file) => {
      const started = performance.now();
      beginDeviceSocketGeneration();
      const { manifest, findings, islands } = await buildGeneration(options.root);
      const remount = remountReason(mounted, { manifest, findings });
      state.manifest = manifest;
      state.appFindings = findings;
      state.islands = islands;
      const unserved = await refreshDevices();
      // Awaited one by one: a shared store answers over the network, and a dev save is rare.
      for (const path of await isr.store().paths()) await isr.store().delete(path);
      state.reloads += 1;
      // Read on EVERY rebuild, so a pin one save reached is never reported against the next save.
      const stale = takeStalePins();
      // A generation this process cannot mount is a restart named after the saved file — never
      // "reloaded" over a route table built for the generation before it.
      const saved = resolve(options.root, file);
      const pins =
        stale.length > 0 || remount === undefined ? stale : [{ changed: saved, pinned: saved }];
      const [device] = unserved;
      state.reloadFinding =
        stale.length > 0 && options.onRestart === undefined
          ? restartFinding(options.root, stale)
          : device !== undefined
            ? unservedDeviceFinding(device, file)
            : remount !== undefined && options.onRestart === undefined
              ? remountFinding(remount, file)
              : undefined;
      if (pins.length > 0 && options.onRestart !== undefined) {
        options.onRestart(
          pins,
          stale.length > 0 || remount === undefined
            ? msg('cli.dev.restart', { reason: restartReason(options.root, stale) })
            : remountLine(remount, file),
        );
      } else options.onReload?.(file, Math.round(performance.now() - started));
    },
    // Same rule as a module that will not import: a save the manifest cannot be rebuilt from is
    // a finding on `/_x`, never an unhandled rejection that takes the dev server down.
    (error: unknown, file: string) => {
      state.reloadFinding = { ...findingFrom(error), at: file };
    },
  );
}
