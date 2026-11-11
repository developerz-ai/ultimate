// One `x dev` generation — the app's manifest and its island bundle — is built by both builders at
// once, at boot as on every save. On a 5,000-file app the two are ~4 s and ~12 s; one after the
// other, the boot paid their sum before its first 200 (scripts/bench/results/boot-large-app.json).

import { describe, expect, test } from 'bun:test';
import type { Manifest } from '@ultimat3/manifest';
import type { AppManifest } from './app-manifest';
import { buildGeneration } from './dev-rebuild';
import type { IslandBundle } from './island-bundle';
import { islandBundle } from './island-bundle';

/** A promise whose resolution the test decides, and a flag saying whether it was asked for. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const manifest = { buildId: 'b1' } as unknown as Manifest;

describe('buildGeneration', () => {
  test('starts the island build before the app load has finished', async () => {
    const load = deferred<AppManifest>();
    const started: string[] = [];
    const generation = buildGeneration('/app', {
      manifest: (root) => {
        started.push(`manifest ${root}`);
        return load.promise;
      },
      islands: async (root) => {
        started.push(`islands ${root}`);
        return islandBundle([]);
      },
    });
    // Both asked for while the load is still pending: neither waits for the other.
    await Bun.sleep(0);
    expect(started).toEqual(['manifest /app', 'islands /app']);
    load.resolve({ manifest, findings: [] });
    const built = await generation;
    expect(built.manifest).toBe(manifest);
    expect(built.findings).toEqual([]);
    expect(built.islands.chunks).toEqual([]);
  });

  test("the island build's realtime answer is read only once the app load has settled", async () => {
    const load = deferred<AppManifest>();
    const steps: string[] = [];
    const generation = buildGeneration('/app', {
      manifest: () => load.promise,
      islands: async (_root, options) => {
        steps.push('islands started');
        // A realtime group asks here; the answer must not arrive while the registry is empty.
        const answer = options.persists?.().then((persists) => {
          steps.push(`persists ${String(persists)}`);
        });
        // A full event-loop turn while the load is pending: an answer that did not wait for it would
        // have settled by now, since nothing but microtasks stands between it and its caller.
        await Bun.sleep(0);
        steps.push('load resolving');
        load.resolve({ manifest, findings: [] });
        await answer;
        return islandBundle([]);
      },
    });
    await generation;
    expect(steps).toEqual(['islands started', 'load resolving', 'persists undefined']);
  });

  test('a failed island build fails the generation, never half of it', async () => {
    const failed = buildGeneration('/app', {
      manifest: async () => ({ manifest, findings: [] }),
      islands: (): Promise<IslandBundle> => Promise.reject(new TypeError('island did not bundle')),
    });
    await expect(failed).rejects.toThrow('island did not bundle');
  });
});
