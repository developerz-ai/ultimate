import { expect, test } from 'bun:test';
import { CONTAINER_BINDING, DEFAULT_PORT, portFromEnv, roleFromEnv, runRole } from './serve';
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
