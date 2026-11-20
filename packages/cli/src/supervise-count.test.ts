// Every clamp auto takes the minimum of, and every refusal an explicit count meets — each from
// injected sources, so no cgroup, config or platform of this machine decides a verdict.

import { describe, expect, test } from 'bun:test';
import type { Role } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { CgroupFacts } from './supervise-cgroup';
import type { CountSources, SharedStateFacts } from './supervise-count';
import { readProcessesRequest, resolveProcessCount, unsharedState } from './supervise-count';

const GIB = 1024 ** 3;

const SHARED: SharedStateFacts = {
  role: 'web',
  lruTier: true,
  crossingBus: true,
  redis: false,
  embeddedDatabase: false,
  stores: [{ name: 'runtime.rateLimitStore', scope: 'shared' }],
};

function sources(
  over: Partial<Omit<CountSources, 'cgroup' | 'shared' | 'pool' | 'prebuilt' | 'role'>> & {
    readonly processes?: string;
    readonly cgroup?: CgroupFacts;
    readonly shared?: Partial<SharedStateFacts>;
    readonly prebuilt?: boolean;
    readonly pool?: number;
    readonly role?: Role;
  } = {},
): CountSources {
  const role = over.role ?? 'web';
  return {
    env: over.processes === undefined ? {} : { ULTIMATE_PROCESSES: over.processes },
    role,
    platform: over.platform ?? 'linux',
    environment: 'environment' in over ? over.environment : 'production',
    cgroup: async () => over.cgroup ?? { cpus: 4, memoryBytes: undefined },
    parallelism: over.parallelism ?? (() => 8),
    pool: () => over.pool ?? 20,
    shared: async () => ({ ...SHARED, role, ...over.shared }),
    prebuilt: async () => over.prebuilt ?? true,
  };
}

async function refusal(input: CountSources): Promise<string> {
  try {
    await resolveProcessCount(input);
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    throw error;
  }
  return expect.unreachable('the count was not refused');
}

describe('unit · readProcessesRequest', () => {
  test('unset, blank and `auto` are auto; a positive whole number is a count', () => {
    expect(readProcessesRequest({})).toBe('auto');
    expect(readProcessesRequest({ ULTIMATE_PROCESSES: ' ' })).toBe('auto');
    expect(readProcessesRequest({ ULTIMATE_PROCESSES: 'auto' })).toBe('auto');
    expect(readProcessesRequest({ ULTIMATE_PROCESSES: '3' })).toBe(3);
  });

  test.each(['0', '-2', '1.5', 'two', '02', '99999999999999999999'])(
    '%p is X_PROCESSES_INVALID',
    (raw) => {
      expect(() => readProcessesRequest({ ULTIMATE_PROCESSES: raw })).toThrow(
        expect.objectContaining({ code: 'X_PROCESSES_INVALID' }),
      );
    },
  );
});

describe('unit · auto', () => {
  test('the CPU quota binds when nothing is lower, capped by the cpuset', async () => {
    expect(
      await resolveProcessCount(sources({ cgroup: { cpus: 2, memoryBytes: undefined } })),
    ).toMatchObject({ count: 2, binding: 'cpu' });
    expect(await resolveProcessCount(sources({ parallelism: () => 3 }))).toMatchObject({
      count: 3,
      binding: 'cpu',
    });
  });

  test('no quota declared is ONE process, whatever the host has', async () => {
    const count = await resolveProcessCount(
      sources({ cgroup: { cpus: undefined, memoryBytes: 8 * GIB } }),
    );
    expect(count).toMatchObject({ count: 1, binding: 'cpu', clamps: { cpu: 1 } });
  });

  test('memory: (ceiling − 32 MiB) / 256 MiB, floored', async () => {
    const count = await resolveProcessCount(sources({ cgroup: { cpus: 8, memoryBytes: 1 * GIB } }));
    expect(count).toMatchObject({ count: 3, binding: 'memory', clamps: { memory: 3 } });
    const tiny = await resolveProcessCount(
      sources({ cgroup: { cpus: 8, memoryBytes: 200 * 1024 ** 2 } }),
    );
    expect(tiny.count).toBe(1);
  });

  test('the pool: never more children than connections', async () => {
    expect(await resolveProcessCount(sources({ pool: 2 }))).toMatchObject({
      count: 2,
      binding: 'pool',
    });
  });

  test.each(['scheduler', 'replicator', 'migrate'] as const)('%s is one process', async (role) => {
    expect(await resolveProcessCount(sources({ role }))).toMatchObject({
      count: 1,
      binding: 'role',
    });
  });

  test('off Linux is one process: reusePort does not balance there', async () => {
    expect(await resolveProcessCount(sources({ platform: 'darwin' }))).toMatchObject({
      count: 1,
      binding: 'platform',
    });
  });

  // The early returns come first: off Linux or on a singleton role the count is 1 whatever the
  // state, and the binding names that cause, never `shared-state` — nor is the app's state asked.
  test.each([
    ['sync', 'darwin', 'platform'],
    ['scheduler', 'linux', 'role'],
  ] as const)(
    '%s on %s binds on %s before shared state is read',
    async (role, platform, binding) => {
      let asked = false;
      const input = sources({
        role,
        platform,
        shared: { crossingBus: false, embeddedDatabase: true },
      });
      const count = await resolveProcessCount({
        ...input,
        shared: async () => {
          asked = true;
          return input.shared();
        },
      });
      expect(count).toEqual({ count: 1, requested: 'auto', binding, clamps: { [binding]: 1 } });
      expect(asked).toBe(false);
    },
  );

  test('unshared state and an image that compiles at boot each clamp to one', async () => {
    const lru = await resolveProcessCount(sources({ shared: { crossingBus: false } }));
    expect(lru).toMatchObject({ count: 1, binding: 'shared-state' });
    expect(await resolveProcessCount(sources({ prebuilt: false }))).toMatchObject({
      count: 1,
      binding: 'image',
    });
  });

  test('outside production and staging it is one process, and an explicit count is a note, not a refusal', async () => {
    for (const environment of ['development', 'test', undefined] as const) {
      expect(await resolveProcessCount(sources({ environment, processes: '4' }))).toMatchObject({
        count: 1,
        binding: 'environment',
        note: { level: 'info', msg: 'ultimate processes ignored' },
      });
    }
    expect((await resolveProcessCount(sources({ environment: 'staging' }))).count).toBe(4);
    expect((await resolveProcessCount(sources({ environment: 'test' }))).note).toBeUndefined();
  });
});

describe('unit · an explicit count', () => {
  test('is honoured over the CPU clamp', async () => {
    const count = await resolveProcessCount(
      sources({ processes: '3', cgroup: { cpus: undefined, memoryBytes: undefined } }),
    );
    expect(count).toMatchObject({ count: 3, binding: 'requested' });
    expect(count.note).toBeUndefined();
  });

  test('1 is never checked', async () => {
    expect(
      (await resolveProcessCount(sources({ processes: '1', role: 'scheduler', platform: 'win32' })))
        .count,
    ).toBe(1);
  });

  test('refuses a singleton role, another platform, unshared state and a pool too small', async () => {
    expect(await refusal(sources({ processes: '2', role: 'scheduler' }))).toBe(
      'X_PROCESSES_ROLE_SINGLETON',
    );
    expect(await refusal(sources({ processes: '2', platform: 'darwin' }))).toBe(
      'X_PROCESSES_UNBALANCED',
    );
    expect(await refusal(sources({ processes: '2', shared: { embeddedDatabase: true } }))).toBe(
      'X_PROCESSES_UNSHARED_STATE',
    );
    expect(await refusal(sources({ processes: '21' }))).toBe('X_PROCESSES_OVER_POOL');
  });

  // Unshared state is refused before the pool: raising DATABASE_POOL_MAX could never make an
  // embedded database or a per-process store safe, so the pool's refusal would be a wrong fix.
  test('unshared state AND a pool too small is refused for the state, the fix that matters', async () => {
    const input = sources({ processes: '4', pool: 2, shared: { embeddedDatabase: true } });
    expect(await refusal(input)).toBe('X_PROCESSES_UNSHARED_STATE');
  });

  test('above the memory fit is a warning, never a refusal', async () => {
    const count = await resolveProcessCount(
      sources({ processes: '4', cgroup: { cpus: 4, memoryBytes: 1 * GIB } }),
    );
    expect(count).toMatchObject({ count: 4, note: { level: 'warn' } });
    expect(count.note?.fix).toStartWith('export ULTIMATE_PROCESSES=3');
  });
});

describe('unit · unsharedState — the one decision', () => {
  test('a crossing bus or Redis shares the lru tier', () => {
    expect(unsharedState({ ...SHARED, crossingBus: false })).toHaveLength(1);
    expect(unsharedState({ ...SHARED, crossingBus: false, redis: true })).toEqual([]);
    expect(unsharedState({ ...SHARED, lruTier: false, crossingBus: false })).toEqual([]);
  });

  test('a store not declared shared, the embedded database, and sync without NATS', () => {
    const reasons = unsharedState({
      ...SHARED,
      role: 'sync',
      redis: true,
      crossingBus: false,
      embeddedDatabase: true,
      stores: [
        { name: 'runtime.idempotencyStore', scope: 'process' },
        { name: 'runtime.rateLimitStore', scope: undefined },
        { name: 'ok', scope: 'shared' },
      ],
    });
    expect(reasons).toHaveLength(4);
    expect(reasons.join('\n')).toContain('runtime.idempotencyStore');
    expect(reasons.join('\n')).toContain('scope undeclared');
    expect(reasons.join('\n')).toContain('sync role');
  });
});
