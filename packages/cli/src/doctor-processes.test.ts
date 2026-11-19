// `x doctor`'s processes fact: each role resolved as a production container here would, the
// connections one container holds, and the two production-only warnings.

import { describe, expect, test } from 'bun:test';
import { reportDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import type { ProcessesFact } from './doctor-processes';
import { connectionsOf, processesWarnings, withProcessesReport } from './doctor-processes';
import type { ProcessesSources } from './doctor-processes-probe';
import { MIGRATE_REQ_PATH, processesFact } from './doctor-processes-probe';
import { CGROUP_PATHS } from './supervise-cgroup';

/** A host whose files are a table: absent paths read as unreadable, as on a host without them. */
const host = (
  files: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>> = {},
): ProcessesSources => ({
  root: undefined,
  env: { DATABASE_URL: 'postgres://db.invalid/app', NATS_URL: 'nats://n:4222', ...env },
  platform: 'linux',
  cores: 8,
  read: async (path) => files[path],
  maxConnections: async () => 100,
});

const QUOTA_2 = { [CGROUP_PATHS.cpuMax]: '200000 100000', [MIGRATE_REQ_PATH]: '0\n' };

const byRole = (fact: ProcessesFact) =>
  Object.fromEntries(
    fact.roles.map((entry) => [
      entry.role,
      'refused' in entry.resolved ? entry.resolved.refused.code : entry.resolved.count,
    ]),
  );

describe('processesFact', () => {
  test('a 2-CPU quota runs 2 web, sync and worker processes; singletons stay at 1', async () => {
    const fact = await processesFact(host(QUOTA_2));
    expect(byRole(fact)).toEqual({ web: 2, sync: 2, worker: 2, scheduler: 1, replicator: 1 });
    expect(fact.cpuBudget).toBe(2);
    expect(fact.migrateReq).toBe('0');
  });

  test('no quota declared is 1 process per role, whatever the host has', async () => {
    const fact = await processesFact(host({ [CGROUP_PATHS.cpuMax]: 'max 100000' }));
    expect(new Set(Object.values(byRole(fact)))).toEqual(new Set([1]));
    expect(fact.cpuBudget).toBeUndefined();
  });

  test('an explicit count a singleton cannot run is reported as its refusal', async () => {
    const fact = await processesFact(host(QUOTA_2, { ULTIMATE_PROCESSES: '2' }));
    expect(byRole(fact)['scheduler']).toBe('X_PROCESSES_ROLE_SINGLETON');
    expect(fact.explicit).toBe(true);
  });
});

describe('connectionsOf', () => {
  test('the pool total is invariant in N; each worker process adds its LISTEN session', async () => {
    const fact = await processesFact(host(QUOTA_2));
    const of = (role: string) => fact.roles.find((entry) => entry.role === role);
    const web = of('web');
    const worker = of('worker');
    if (web === undefined || worker === undefined) return expect.unreachable('roles missing');
    expect(connectionsOf(web)).toBe(20);
    expect(connectionsOf(worker)).toBe(8 + 2);
  });
});

describe('processesWarnings', () => {
  test('production with no CPU budget on a multi-core host is told to declare one', async () => {
    const fact = await processesFact(host({}, { ULTIMATE_ENV: 'production' }));
    expect(processesWarnings(fact).map((warning) => warning.code)).toEqual([
      'X_PROCESSES_CPU_UNDECLARED',
    ]);
  });

  test('N > 1 with tcp_migrate_req at 0 is warned; at 1 it is not', async () => {
    const off = await processesFact(host(QUOTA_2, { ULTIMATE_ENV: 'production' }));
    expect(processesWarnings(off).map((warning) => warning.code)).toEqual([
      'X_PROCESSES_MIGRATE_REQ_OFF',
    ]);
    const on = await processesFact(
      host({ ...QUOTA_2, [MIGRATE_REQ_PATH]: '1' }, { ULTIMATE_ENV: 'production' }),
    );
    expect(processesWarnings(on)).toEqual([]);
  });

  test('a development host owes neither warning: a laptop declares no CPU budget', async () => {
    const fact = await processesFact(
      host({ [MIGRATE_REQ_PATH]: '0' }, { NODE_ENV: 'development' }),
    );
    expect(processesWarnings(fact)).toEqual([]);
  });

  test('an explicit ULTIMATE_PROCESSES=1 says one is meant: no CPU warning', async () => {
    const fact = await processesFact(
      host({}, { ULTIMATE_ENV: 'production', ULTIMATE_PROCESSES: '1' }),
    );
    expect(processesWarnings(fact)).toEqual([]);
  });
});

describe('withProcessesReport', () => {
  test('data.processes carries every role, a line each, and the max_connections comparison', async () => {
    const fact = await processesFact(host(QUOTA_2));
    const result = withProcessesReport({ ok: true, command: 'doctor', summary: 's' }, fact);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      processes: {
        cores: 8,
        cpuBudget: 2,
        maxConnections: 100,
        // web 20, sync 10, worker 8 + 2 LISTEN, scheduler 2, replicator 4.
        connectionsOneOfEach: 20 + 10 + 10 + 2 + 4,
        roles: expect.arrayContaining([
          { role: 'web', count: 2, binding: 'cpu', pool: 20, listen: 0, connections: 20 },
        ]),
      },
    });
    expect(result.lines?.length).toBe(1 + 5 + 1);
  });
});

describe('x doctor', () => {
  test('reports the fact beside the verdict and its warnings in data.warnings', async () => {
    const fact = await processesFact(host({}, { ULTIMATE_ENV: 'production' }));
    const result = await reportDoctor(probe({ processes: async () => fact }));
    expect(result.data).toMatchObject({ processes: { cpuBudget: null } });
    const warnings = (result.data as { warnings?: readonly { code: string }[] }).warnings ?? [];
    expect(warnings.map((warning) => warning.code)).toContain('X_PROCESSES_CPU_UNDECLARED');
  });
});
