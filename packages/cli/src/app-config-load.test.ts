// The one config loader, against real files on disk: every key the seventeen deleted walks read,
// declared in ONE fixture and read back typed, then left out and read back at the default each walk
// answered — plus the refusals a walk used to answer with "every default".

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask where the temp directory is.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API.
import { join } from 'node:path';
import { DEFAULT_SPECULATION, isUltimateError } from '@ultimat3/core';
import { APP_CONFIG_EXPORT, appConfigExport, loadAppConfig } from './app-config-load';
import { processRoot } from './process-root-fixture';

const dirs: string[] = [];

async function appRoot(source: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-app-config-load-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every key a deleted walk read, each set to something other than its default. */
const EVERY_KEY = `export const envSchema = { PORT: { type: 'port' } };
export const config = {
  name: 'every-key',
  locales: ['es-co', 'en'],
  defaultLocale: 'es-co',
  theme: { defaultMode: 'dark' },
  auth: { signInPath: '/sign-in' },
  pwa: {
    enabled: true,
    name: 'Every Key',
    colors: {
      light: { themeColor: '#111111', backgroundColor: '#ffffff' },
      dark: { themeColor: '#eeeeee', backgroundColor: '#000000' },
    },
    offline: { fallback: '/offline', neverCache: ['/api/*'], personalPages: 'last-member' },
    backgroundSync: true,
    push: true,
  },
  cache: { tiers: ['request-memo'] },
  jobs: { queues: ['mail'], concurrency: 3, visibilityTimeoutMs: 45000 },
  realtime: { enabled: false, transport: 'nats', urlEnv: 'BUS_URL' },
  notify: { inboxReadRetentionMs: 1000, inboxUnreadRetentionMs: 2000 },
  ai: { mcp: { expose: false, path: '/tools' } },
  drain: { readinessGraceMs: 7000 },
  health: { readiness: 'process' },
  site: { origin: 'https://every.example' },
  seo: { robots: { disallow: ['/panel'] }, sitemap: { extra: ['/about'], lastmod: 'build' } },
  navigation: { client: ['app'], speculation: { prefetch: 'conservative', exclude: ['/x/*'] } },
  islands: { sharedChunks: true },
};
`;

const failureOf = async (root: string): Promise<{ code: string; cause: string }> => {
  const error: unknown = await loadAppConfig(root).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return isUltimateError(error)
    ? { code: error.code, cause: error.cause ?? '' }
    : { code: 'not coded', cause: '' };
};

describe('loadAppConfig', () => {
  test('every key a walk read is read back as declared, in one fixture', async () => {
    const root = await appRoot(EVERY_KEY);
    const config = await loadAppConfig(root);
    expect(config?.name).toBe('every-key');
    expect(config?.locales).toEqual(['es-co', 'en']);
    expect(config?.defaultLocale).toBe('es-co');
    expect(config?.theme.defaultMode).toBe('dark');
    expect(config?.auth.signInPath).toBe('/sign-in');
    expect(config?.pwa.enabled).toBe(true);
    expect(config?.pwa.name).toBe('Every Key');
    expect(config?.pwa.colors?.dark.backgroundColor).toBe('#000000');
    expect(config?.pwa.offline.fallback).toBe('/offline');
    expect(config?.pwa.offline.neverCache).toEqual(['/api/*']);
    expect(config?.pwa.offline.personalPages).toBe('last-member');
    expect([config?.pwa.backgroundSync, config?.pwa.push]).toEqual([true, true]);
    expect(config?.cache.tiers).toEqual(['request-memo']);
    expect(config?.jobs.queues).toEqual(['mail']);
    expect(config?.jobs.concurrency).toBe(3);
    expect(config?.jobs.visibilityTimeoutMs).toBe(45000);
    expect(config?.realtime).toEqual({ enabled: false, transport: 'nats', urlEnv: 'BUS_URL' });
    expect(config?.notify.inboxReadRetentionMs).toBe(1000);
    expect(config?.notify.inboxUnreadRetentionMs).toBe(2000);
    expect(config?.ai.mcp).toEqual({ expose: false, path: '/tools' });
    expect(config?.drain.readinessGraceMs).toBe(7000);
    expect(config?.health.readiness).toBe('process');
    expect(config?.site.origin).toBe('https://every.example');
    expect(config?.seo.robots.disallow).toEqual(['/panel']);
    expect(config?.seo.sitemap).toEqual({ extra: ['/about'], lastmod: 'build' });
    expect(config?.navigation.client).toEqual(['app']);
    expect(config?.navigation.speculation).toEqual({
      prefetch: 'conservative',
      exclude: ['/x/*'],
    });
    expect(config?.islands.sharedChunks).toBe(true);
    // The one export that is not `config`: `app-env.ts`'s schema, through the same import.
    expect(await appConfigExport(root, 'envSchema')).toEqual({ PORT: { type: 'port' } });
  });

  // The answer each walk gave a config that named the section without the key — core's default,
  // now from core rather than restated per file.
  test('a config naming nothing reads every one of those keys at its old default', async () => {
    const config = await loadAppConfig(await appRoot("export const config = { name: 'bare' };\n"));
    expect(config?.locales).toEqual(['en']);
    expect(config?.defaultLocale).toBe('en');
    expect(config?.theme.defaultMode).toBe('system');
    expect(config?.auth.signInPath).toBeNull();
    expect(config?.pwa.enabled).toBe(false);
    expect([config?.pwa.backgroundSync, config?.pwa.push]).toEqual([false, false]);
    expect(config?.pwa.offline.fallback).toBeNull();
    expect(config?.cache.tiers).toEqual(['request-memo', 'lru']);
    expect(config?.jobs.queues).toEqual(['bare-default']);
    expect(config?.jobs.concurrency).toBe(8);
    expect(config?.jobs.visibilityTimeoutMs).toBe(30000);
    expect(config?.realtime).toEqual({ enabled: true, transport: 'memory', urlEnv: undefined });
    expect(config?.notify.inboxReadRetentionMs).toBeUndefined();
    expect(config?.notify.inboxUnreadRetentionMs).toBeUndefined();
    expect(config?.ai.mcp).toEqual({ expose: true, path: '/mcp' });
    expect(typeof config?.drain.readinessGraceMs).toBe('number');
    expect(config?.health.readiness).toBe('dependencies');
    expect(config?.site.origin).toBeNull();
    expect(config?.seo.robots.disallow).toEqual([]);
    expect(config?.seo.sitemap).toEqual({ extra: [], lastmod: 'none' });
    expect(config?.navigation.client).toEqual([]);
    expect(config?.navigation.speculation).toEqual(DEFAULT_SPECULATION);
    expect(config?.islands.sharedChunks).toBe(false);
  });

  test('a root with no app.config.ts is not an app: undefined, and no export', async () => {
    const root = await appRoot(undefined);
    expect(await loadAppConfig(root)).toBeUndefined();
    expect(await appConfigExport(root, APP_CONFIG_EXPORT)).toBeUndefined();
  });

  // A fixture inside the workspace, so it resolves `@ultimat3/core`, and never a tracked app's own
  // config: `examples/dummy/app.config.ts` calls `defineMeasurementActor`, process-global state
  // that made `prerender-actor.test.ts` measure as the wrong actor when it ran later in one process.
  test('a config built by defineConfig re-merges to itself', async () => {
    const root = processRoot(join(import.meta.dir, '..', '.app-config-load-fixture'));
    dirs.push(root);
    await Bun.write(
      join(root, 'app.config.ts'),
      EVERY_KEY.replace(
        'export const config = {',
        "import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({",
      ).replace(/\n};\n$/, '\n});\n'),
    );
    const declared = await appConfigExport(root, APP_CONFIG_EXPORT);
    expect(await loadAppConfig(root)).toEqual(declared as never);
    expect((declared as { name?: unknown }).name).toBe('every-key');
    // `defineConfig`'s own output is frozen: proof the fixture really went through it.
    expect(Object.isFrozen(declared)).toBe(true);
  });

  // Each of these was "every default" to the walks — a deployment that silently ignored its file.
  test('a file with no config object is refused, naming the export', async () => {
    for (const source of [
      'export const other = 1;\n',
      'export const config = null;\n',
      "export const config = ['a'];\n",
    ]) {
      const failure = await failureOf(await appRoot(source));
      expect(failure.code).toBe('X_CONFIG_INVALID');
      expect(failure.cause).toContain('exports no config object');
    }
  });

  test('a hand-built config is held to core’s validator, not read around', async () => {
    const failure = await failureOf(
      await appRoot("export const config = { name: 'hand', realtime: { transport: 'redis' } };\n"),
    );
    expect(failure.code).toBe('X_CONFIG_INVALID');
    expect(failure.cause).toContain('realtime.transport');
  });
});
