import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture is joined to this file's directory.
import { join } from 'node:path';
import type { ErrorReport } from '@ultimat3/core';
import {
  configureErrorReporting,
  InternalError,
  memoryErrorReporter,
  reportError,
  resetErrorReporting,
} from '@ultimat3/core';
import { DEFAULT_METRICS_PORT } from './metrics-endpoint';
import {
  CONTAINER_BINDING,
  configureReporting,
  DEFAULT_PORT,
  ERROR_DSN_KEY,
  metricsPortFor,
  metricsPortFromEnv,
  portFromEnv,
  releaseBoot,
  roleFromEnv,
  runRole,
  withAppRuntime,
} from './serve';
import type { ThrownShape } from './thrown-by';
import { thrownBy } from './thrown-by';

test('ROLE defaults to web and accepts every real role', () => {
  expect(roleFromEnv({})).toBe('web');
  for (const role of ['web', 'sync', 'worker', 'scheduler', 'replicator', 'migrate'] as const) {
    expect(roleFromEnv({ ROLE: role })).toBe(role);
  }
});

test('an unknown ROLE is refused with the run that fixes it, never defaulted to web', () => {
  const thrown: ThrownShape = thrownBy(() => roleFromEnv({ ROLE: 'wroker' }));
  expect(thrown.code).toBe('X_ROLE_UNKNOWN');
  expect(thrown.cause).toContain('wroker');
  expect(thrown.fix).toContain('ROLE=web');
});

test('PORT is bound as the platform injected it', () => {
  expect(portFromEnv({ PORT: '8080' })).toBe(8080);
  // A PaaS that sets an empty PORT means "you choose"; a missing one means the same.
  expect(portFromEnv({})).toBe(DEFAULT_PORT);
  expect(portFromEnv({ PORT: '  ' })).toBe(DEFAULT_PORT);
  // 0 is the kernel picking one, which is what a test wants and a platform never sends.
  expect(portFromEnv({ PORT: '0' })).toBe(0);
});

test('a PORT that is not a port fails the boot instead of silently becoming 3000', () => {
  // `Number.parseInt` reads every one of these as a number, which is how a process comes up on a
  // port the platform is not routing to and fails a health probe with nothing in the log.
  for (const value of ['80abc', 'auto', '70000', '-1', '3000.5']) {
    const thrown: ThrownShape = thrownBy(() => portFromEnv({ PORT: value }));
    expect(thrown.code).toBe('X_PORT_INVALID');
    expect(thrown.cause).toContain(value);
  }
});

test('METRICS_PORT is its own knob, so moving the app port does not move the scrape', () => {
  expect(metricsPortFromEnv({})).toBe(DEFAULT_METRICS_PORT);
  expect(metricsPortFromEnv({ PORT: '8080' })).toBe(DEFAULT_METRICS_PORT);
  expect(metricsPortFromEnv({ METRICS_PORT: '9464' })).toBe(9464);
});

test('a METRICS_PORT that is not a port names ITSELF, or the fix line edits the wrong var', () => {
  const thrown: ThrownShape = thrownBy(() => metricsPortFromEnv({ METRICS_PORT: 'auto' }));
  expect(thrown.code).toBe('X_PORT_INVALID');
  expect(thrown.cause).toContain('METRICS_PORT="auto"');
  expect(thrown.fix).toContain('METRICS_PORT=9090');
});

// The bug this guards: `serve.ts` computed this inline and `cmd-dev.ts` passed nothing, so
// `METRICS_PORT` was honoured in the container and ignored by `x dev` — the dev/prod parity break
// `dev-roles.ts`'s own header forbids. One expression, both callers.
test('metricsPortFor is the one answer both the container and x dev read', () => {
  expect(metricsPortFor({}, 3000)).toBe(DEFAULT_METRICS_PORT);
  expect(metricsPortFor({ METRICS_PORT: '9464' }, 3000)).toBe(9464);
  // An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
  // fixed 9090 would fail the next suite booting beside it.
  expect(metricsPortFor({}, 0)).toBe(0);
  // An environment that names the port still wins at port 0 — that is the deploy talking.
  expect(metricsPortFor({ METRICS_PORT: '9464' }, 0)).toBe(9464);
  // An explicit override outranks both.
  expect(metricsPortFor({ METRICS_PORT: '9464' }, 0, 9999)).toBe(9999);
});

test('a container binds every interface, and dev does not', () => {
  expect(CONTAINER_BINDING).toEqual({ dev: false, hostname: '0.0.0.0' });
});

// The app's `apps/<app>/runtime.ts`, resolved ONCE per public entry: a caller's own `runtime` wins,
// the file fills in when none was passed, and a root with no `apps/` at all is handed back as is.
test('withAppRuntime reads apps/<app>/runtime.ts only when the caller passed no runtime', async () => {
  const root = join(import.meta.dir, '..', '.serve-runtime-fixture');
  await rm(root, { recursive: true, force: true });
  try {
    await Bun.write(
      join(root, 'apps/web/runtime.ts'),
      'export const runtime = { middleware: [async (_ctx, next) => next()] };\n',
    );
    const found = await withAppRuntime({ root, env: {} });
    expect(found.runtime?.middleware).toHaveLength(1);

    const own = { middleware: [] };
    expect((await withAppRuntime({ root, env: {}, runtime: own })).runtime).toBe(own);

    const bare = { root: '/nonexistent-app-root', env: {} };
    expect(await withAppRuntime(bare)).toBe(bare);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runRole refuses a bad ROLE before it starts a single service', async () => {
  // The root does not exist: reaching it at all would mean the role was resolved too late, after
  // `resolveServices` had already created `.x/` somewhere it had no business creating it.
  expect(runRole({ root: '/nonexistent-app-root', env: { ROLE: 'webb' } })).rejects.toThrow(
    'X_ROLE_UNKNOWN',
  );
});

test('every report a container sends is tagged with the build id this boot computed', () => {
  const reporter = memoryErrorReporter();
  configureErrorReporting({ reporter });
  configureReporting({}, 'build-abc');
  reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'http' });

  // `x-ultimate-build` and the release a monitor groups by are ONE identity, not two.
  expect((reporter.events[0] as ErrorReport).release).toBe('build-abc');
  resetErrorReporting();
});

test('no DSN leaves the no-op reporter in place, so a laptop pages nobody', () => {
  resetErrorReporting();
  // Absent, empty and whitespace all mean "not configured" — a platform that injects an empty
  // string must not be read as a monitor at an empty URL.
  for (const env of [{}, { SENTRY_DSN: '' }, { SENTRY_DSN: '   ' }]) {
    expect(() => {
      configureReporting(env, 'build-abc');
    }).not.toThrow();
  }
  resetErrorReporting();
});

test('a malformed DSN fails the boot, because a monitor never connected looks like no failures', () => {
  const thrown: ThrownShape = thrownBy(() => {
    configureReporting({ [ERROR_DSN_KEY]: 'not-a-dsn' }, 'build-abc');
  });
  expect(thrown.code).toBe('X_ERROR_REPORTER_DSN_INVALID');
  resetErrorReporting();
});

// A boot that throws between `startServices` and `startRoles` used to leave the Postgres pool, the
// queue and the OTLP exporter running in a process whose caller has already given up — and both
// `x dev` and the container retry, so the second attempt met a `.x/pgdata` the first one held.
test('a failed boot releases what it acquired, newest first', async () => {
  const released: string[] = [];
  await releaseBoot([
    () => void released.push('services'),
    async () => void released.push('otlp'),
    () => void released.push('roles'),
  ]);
  expect(released).toEqual(['roles', 'otlp', 'services']);
});

test('a release that itself fails does not strand the ones acquired before it', async () => {
  const released: string[] = [];
  await releaseBoot([
    () => void released.push('services'),
    () => {
      throw new TypeError('stop() on a half-started exporter');
    },
    async () => void released.push('roles'),
  ]);
  // The step that refused to START is the failure worth reporting; a stop on the way out is not.
  expect(released).toEqual(['roles', 'services']);
});
