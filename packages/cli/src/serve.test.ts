import { expect, test } from 'bun:test';
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
  metricsPortFromEnv,
  portFromEnv,
  releaseBoot,
  roleFromEnv,
  runRole,
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

test('a container binds every interface, and dev does not', () => {
  expect(CONTAINER_BINDING).toEqual({ dev: false, hostname: '0.0.0.0' });
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
