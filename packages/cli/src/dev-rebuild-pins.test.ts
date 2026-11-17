// A save whose generation will not build still reached what it reached: the pinned modules its
// rescan stopped at are this process's to hold from then on. Left untaken, a failed rebuild's pins
// were read by the NEXT save as its own and named in that save's restart (audit round 2).

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { Manifest } from '@ultimat3/manifest';
import { isrController } from '@ultimat3/render/server';
import type { StalePin } from './app-reload-graph';
import { evictChanged, pinModule, resetReloadGraph, trackModule } from './app-reload-graph';
import type { DevState, GenerationBuilders } from './dev-rebuild';
import { devRebuilder } from './dev-rebuild';
import { islandBundle } from './island-bundle';

/** No file lives here: a module recorded with text reads back as changed on the next rescan. */
const ROOT = '/x-dev-rebuild-pins-fixture';
const manifest = { buildId: 'b1', routes: [], actions: [], queries: [] } as unknown as Manifest;

afterEach(() => resetReloadGraph());

/** What a rescan does when `module`, a pinned one, changed: it is recorded as held stale. */
async function reachPin(module: string): Promise<void> {
  const absolute = `${ROOT}/${module}`;
  pinModule(absolute);
  await trackModule(absolute, 'export const generation = 1;', ROOT);
  await evictChanged(ROOT);
}

/** A rebuilder over builders the test drives; `restarts` resolves on the first restart. */
function harness(builders: GenerationBuilders) {
  const state: DevState = {
    manifest,
    reloads: 0,
    reloadFinding: undefined,
    appFindings: [],
    islands: islandBundle([]),
  };
  let restarted: (pins: readonly StalePin[]) => void = () => undefined;
  const restarts = new Promise<readonly StalePin[]>((resolve) => {
    restarted = resolve;
  });
  const trigger = devRebuilder(
    { root: ROOT, onRestart: (pins) => restarted(pins) },
    state,
    isrController({ routes: () => [] }),
    async () => [],
    builders,
  );
  return { state, trigger, restarts };
}

describe('unit · x dev rebuild, stale pins', () => {
  test("a failed rebuild's pins are never named as the next save's", async () => {
    let saves = 0;
    const { state, trigger, restarts } = harness({
      manifest: async () => {
        saves += 1;
        if (saves === 1) {
          await reachPin('apps/web/api/first.ts');
          throw new UltimateError({
            code: 'X_CONFIG_INVALID',
            cause: 'the first save will not build, in a test',
            fix: 'x dev',
          });
        }
        await reachPin('apps/web/api/second.ts');
        return { manifest, findings: [] };
      },
      islands: async () => islandBundle([]),
      schema: async () => [],
    });
    trigger('apps/web/api/first.ts');
    // Coalesced: runs once the failed rebuild settled.
    trigger('apps/web/api/second.ts');
    const pins = await restarts;
    expect(pins.map((pin) => pin.pinned)).toEqual([`${ROOT}/apps/web/api/second.ts`]);
    expect(state.reloads).toBe(1);
  });

  test('a failed rebuild that reached a pin still holds it for a later save that reached none', async () => {
    let saves = 0;
    const { trigger, restarts } = harness({
      manifest: async () => {
        saves += 1;
        if (saves === 1) {
          await reachPin('apps/web/api/first.ts');
          throw new UltimateError({
            code: 'X_CONFIG_INVALID',
            cause: 'the first save will not build, in a test',
            fix: 'x dev',
          });
        }
        return { manifest, findings: [] };
      },
      islands: async () => islandBundle([]),
      schema: async () => [],
    });
    trigger('apps/web/api/first.ts');
    trigger('apps/web/app/page.tsx');
    // The process still runs the old instance of `first.ts`: a restart, not "reloaded".
    const pins = await restarts;
    expect(pins.map((pin) => pin.pinned)).toEqual([`${ROOT}/apps/web/api/first.ts`]);
  });
});
