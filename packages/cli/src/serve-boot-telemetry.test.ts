// #1361: a served role exported every span as `service.name=ultimate`, `service.version=0.0.1`, so
// every app in one collector was one service and no trace named its build. The boot names it now:
// `OTEL_SERVICE_NAME` > `service.name` in `OTEL_RESOURCE_ATTRIBUTES` > the app's `name`, and
// `service.version` in the attributes > `BUILD_ID` > `APP_VERSION` — env first, before the config
// loads, so a span the app's own config opens already carries what the env said.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { MemoryExporter } from '@ultimat3/core';
import { memoryExporter, resetLifecycle, startSpan, subscribe } from '@ultimat3/core';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';
import { resourceAttributes, serviceIdentityFromEnv } from './serve-boot-telemetry';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-telemetry-fixture'));
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetLifecycle();
});

function exported(): MemoryExporter {
  const exporter = memoryExporter();
  releases.push(subscribe('span.end', (event) => exporter.export(event.payload)));
  return exporter;
}

/** An app named `shop`; `onLoad` is source evaluated while `app.config.ts` is imported. */
async function app(dir: string, onLoad = ''): Promise<string> {
  // A fresh directory per call: a module is evaluated once per process, so a rerun in the same
  // process (flake-hunt) would import the cached `app.config.ts` and its load-time span never fires.
  // Never a module-level counter: `--rerun-each` evaluates this file again, the counter restarts
  // at 0, and the "fresh" path is the first run's — still in the import cache.
  const root = join(ROOT, `${dir}-${crypto.randomUUID()}`);
  await Bun.write(join(root, 'package.json'), JSON.stringify({ name: dir, version: '1.0.0' }));
  await Bun.write(
    join(root, 'app.config.ts'),
    "import { defineConfig, startSpan } from '@ultimat3/core';\n" +
      `${onLoad}\nexport const config = defineConfig({ name: 'shop' });\n`,
  );
  return root;
}

/** Boots a worker over `env`, and answers the resource a span recorded once it is up. */
async function servedResource(root: string, env: Record<string, string>) {
  const exporter = exported();
  const served = await serveApp({
    root,
    env: { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(root, '.x'), BUILD_ID: 'b-77', ...env },
    role: 'worker',
    port: 0,
    metricsPort: 0,
  });
  if (served.kind !== 'served') return expect.unreachable('a worker boot serves');
  try {
    startSpan('probe').end();
    return { exporter, resource: exporter.spans.at(-1)?.resource };
  } finally {
    await served.stop();
  }
}

/** What a span records once no boot is running: the identity the boot found, given back. */
function idleResource() {
  const exporter = exported();
  startSpan('idle').end();
  return exporter.spans.at(-1)?.resource;
}

describe('unit · OTEL_RESOURCE_ATTRIBUTES', () => {
  test('comma-separated pairs, values percent-decoded, blanks skipped', () => {
    expect(
      resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: ' service.name = a%20b ,, k=v=w' }),
    ).toEqual(
      new Map([
        ['service.name', 'a b'],
        ['k', 'v=w'],
      ]),
    );
  });

  test('one malformed pair discards the whole value, as the OTel spec says', () => {
    expect(resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=a,broken' }).size).toBe(0);
    expect(resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=%E0%A4%A' }).size).toBe(0);
    expect(resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: '=x' }).size).toBe(0);
  });

  test('the env alone: name and version as far as the env can say them', () => {
    expect(serviceIdentityFromEnv({})).toEqual({ serviceVersion: 'dev' });
    expect(serviceIdentityFromEnv({ APP_VERSION: '3.1.0' })).toEqual({ serviceVersion: '3.1.0' });
    expect(serviceIdentityFromEnv({ APP_VERSION: '3.1.0', BUILD_ID: 'b-1' })).toEqual({
      serviceVersion: 'b-1',
    });
    expect(
      serviceIdentityFromEnv({
        OTEL_SERVICE_NAME: 'api',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=worker,service.version=9',
        BUILD_ID: 'b-1',
      }),
    ).toEqual({ serviceName: 'api', serviceVersion: '9' });
    // Empty is unset: a platform that exports the key bare has named nothing.
    expect(serviceIdentityFromEnv({ OTEL_SERVICE_NAME: '', BUILD_ID: '' })).toEqual({
      serviceVersion: 'dev',
    });
  });
});

describe('unit · the boot names the service its spans carry', () => {
  test("the app's name and the stamped build, released with the boot", async () => {
    const root = await app('named');
    const { resource } = await servedResource(root, {});
    expect(resource).toEqual({ serviceName: 'shop', serviceVersion: 'b-77' });
    expect(idleResource()).toEqual({ serviceName: 'unknown_service', serviceVersion: 'dev' });
  }, 120_000);

  test('OTEL_SERVICE_NAME beats the app name', async () => {
    const root = await app('override');
    const { resource } = await servedResource(root, { OTEL_SERVICE_NAME: 'shop-api' });
    expect(resource?.serviceName).toBe('shop-api');
  }, 120_000);

  test('service.name in OTEL_RESOURCE_ATTRIBUTES alone beats the app name; its version, BUILD_ID', async () => {
    const root = await app('attributes');
    const { resource } = await servedResource(root, {
      OTEL_RESOURCE_ATTRIBUTES: 'service.name=worker,service.version=2026.11.27',
    });
    expect(resource).toEqual({ serviceName: 'worker', serviceVersion: '2026.11.27' });
  }, 120_000);

  // Before the config is read, only the env can name the service — so a span opened while it
  // loads carries exactly the env's answer, and the stamped build as its version.
  test('a span opened while app.config.ts loads carries the env-supplied identity', async () => {
    const root = await app('during-load', "startSpan('config.load').end();");
    const { exporter } = await servedResource(root, { OTEL_SERVICE_NAME: 'from-env' });
    const during = exporter.spans.find((span) => span.name === 'config.load');
    expect(during?.resource).toEqual({ serviceName: 'from-env', serviceVersion: 'b-77' });
  }, 120_000);
});
