// What a real `app.config.ts` on disk resolves to for the `realtime` section: the three keys a boot
// now obeys, the defaults an absent section means, and the one shape refused rather than guessed.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `Object.keys(Bun)` has `file`,
// `write` and `Glob`, and nothing that makes or removes a directory tree.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask the platform where its temporary
// directory is.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API, so the temp root and the config file are joined with this.
import { join } from 'node:path';
import { defineConfig, isUltimateError } from '@ultimat3/core';
import { loadRealtimeConfig, REALTIME_DEFAULTS } from './runtime-realtime';

const dirs: string[] = [];

/** A scratch app root holding exactly the `app.config.ts` a case is about. */
async function appRoot(source: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-realtime-config-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadRealtimeConfig', () => {
  test('reads all three keys out of the app own config', async () => {
    const root = await appRoot(
      "export const config = { realtime: { enabled: true, transport: 'nats', urlEnv: 'BUS_URL' } };\n",
    );
    expect(await loadRealtimeConfig(root)).toEqual({
      enabled: true,
      transport: 'nats',
      urlEnv: 'BUS_URL',
    });
  });

  // Core's `defaults()`: on, in-process — an app with no section keeps 21.x's `sync` in `x dev`, and
  // `enabled: false` is the explicit opt-out. The same answer `defineConfig` gives, so a boot cannot
  // disagree with the config object the app itself holds.
  test('no file and no section are core defaults: enabled, in-process', async () => {
    expect(await loadRealtimeConfig(await appRoot(undefined))).toEqual(REALTIME_DEFAULTS);
    expect(
      await loadRealtimeConfig(await appRoot("export const config = { name: 'a' };\n")),
    ).toEqual(REALTIME_DEFAULTS);
    expect(REALTIME_DEFAULTS).toEqual({ enabled: true, transport: 'memory', urlEnv: undefined });
    expect(defineConfig({ name: 'myapp' }).realtime).toEqual(REALTIME_DEFAULTS);
  });

  test('a section naming only some keys keeps the defaults for the rest', async () => {
    const root = await appRoot('export const config = { realtime: { enabled: false } };\n');
    expect(await loadRealtimeConfig(root)).toEqual({
      enabled: false,
      transport: 'memory',
      urlEnv: undefined,
    });
  });

  // A hand-built object never met `defineConfig`'s validator. Guessing a bus for a value nothing
  // builds is how `'redis'` booted NATS for two majors, so it is refused here too.
  test('a transport nothing builds is refused, naming the key', async () => {
    const root = await appRoot(
      "export const config = { realtime: { enabled: true, transport: 'redis' } };\n",
    );
    const error: unknown = await loadRealtimeConfig(root).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_CONFIG_INVALID');
    expect(isUltimateError(error) ? error.cause : '').toContain('realtime.transport');
  });
});
