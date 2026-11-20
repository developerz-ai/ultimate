// `x doctor`'s processes fact, pure: how many processes a production container of each role runs
// here (`resolveProcessCount`, and the clamp that bound it), the connections one container holds
// (Σ child pool shares + one LISTEN session per worker process), and the two warnings a production
// host owes: no CPU budget declared, and N > 1 with `net.ipv4.tcp_migrate_req` off.

import type { Environment, Role } from '@ultimat3/core';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import type { ProcessCount } from './supervise-count';

/** One role, resolved: its count, or the refusal an explicit `ULTIMATE_PROCESSES` met. */
export interface RoleProcesses {
  readonly role: Role;
  readonly resolved: ProcessCount | { readonly refused: Finding };
  /** The container's pool: `DATABASE_POOL_MAX`, else the role's profile. */
  readonly pool: number;
  /** LISTEN sessions per process: the worker's queue wake holds one outside the pool. */
  readonly listen: 0 | 1;
}

export interface ProcessesFact {
  readonly environment: Environment;
  /** Cores this process sees (`navigator.hardwareConcurrency`): every host core without a quota. */
  readonly cores: number;
  /** Whole CPUs the cgroup declares; `undefined` when none is. */
  readonly cpuBudget: number | undefined;
  /** `ULTIMATE_PROCESSES` was set to a count, so the operator chose and the CPU warning is moot. */
  readonly explicit: boolean;
  /** `/proc/sys/net/ipv4/tcp_migrate_req`, trimmed; `undefined` off Linux or unreadable. */
  readonly migrateReq: string | undefined;
  readonly roles: readonly RoleProcesses[];
  /** The server's `max_connections`; `undefined` when no external database answered. */
  readonly maxConnections: number | undefined;
}

const PRODUCTION_LIKE: ReadonlySet<Environment> = new Set(['production', 'staging']);

const countOf = (entry: RoleProcesses): number | undefined =>
  'count' in entry.resolved ? entry.resolved.count : undefined;

/** Σ childShare(pool, i, N) is max(pool, N); each process adds its LISTEN session. */
export const connectionsOf = (entry: RoleProcesses): number | undefined => {
  const count = countOf(entry);
  return count === undefined ? undefined : Math.max(entry.pool, count) + count * entry.listen;
};

const COMPOSE = 'docker/docker-compose.prod.yml';

/** Warnings, on a production-like host only: a laptop declares no CPU budget and owes none. */
export function processesWarnings(fact: ProcessesFact): readonly Finding[] {
  const refused = fact.roles.flatMap((entry) =>
    'refused' in entry.resolved ? [entry.resolved.refused] : [],
  );
  if (!PRODUCTION_LIKE.has(fact.environment)) return refused;
  const warnings: Finding[] = [...refused];
  if (fact.cpuBudget === undefined && fact.cores > 1 && !fact.explicit) {
    warnings.push({
      code: 'X_PROCESSES_CPU_UNDECLARED',
      cause: `this container declares no CPU budget on a host with ${fact.cores} cores, so ULTIMATE_PROCESSES=auto runs 1 process per role`,
      fix: `cpus: '2'   # on the role's service in ${COMPOSE} (resources.limits.cpu in Kubernetes); or ULTIMATE_PROCESSES=1 to say one is meant`,
      docs: ERROR_DOCS_URL,
    });
  }
  // Only where the knob exists and reads 0: a kernel before 5.14 has none (`migrateReq` undefined),
  // and the compose line would then stop the container from being created at all.
  const shared = fact.roles.filter((entry) => (countOf(entry) ?? 1) > 1);
  if (shared.length > 0 && fact.migrateReq === '0') {
    const roles = shared.map((entry) => `${entry.role} (${countOf(entry)})`).join(', ');
    warnings.push({
      code: 'X_PROCESSES_MIGRATE_REQ_OFF',
      cause: `this kernel has net.ipv4.tcp_migrate_req and it reads 0 while ${roles} share a port: a process that closes its listener resets every connection queued on it (measured 93–109 of 200; 0 with the sysctl)`,
      fix: `sysctls: { net.ipv4.tcp_migrate_req: 1 }   # uncomment it on web and sync in ${COMPOSE}; Linux >= 5.14 only — this host has the knob, an older kernel refuses to create the container`,
      docs: ERROR_DOCS_URL,
    });
  }
  return warnings;
}

const roleJson = (entry: RoleProcesses): JsonValue =>
  'refused' in entry.resolved
    ? { role: entry.role, refused: entry.resolved.refused.code }
    : {
        role: entry.role,
        count: entry.resolved.count,
        binding: entry.resolved.binding,
        pool: entry.pool,
        listen: entry.listen * entry.resolved.count,
        connections: connectionsOf(entry) ?? null,
      };

/** The fact beside the verdict: `data.processes` for a machine, a line per role for a person. */
export function withProcessesReport(result: CommandResult, fact: ProcessesFact): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const perContainer = fact.roles.reduce((sum, entry) => sum + (connectionsOf(entry) ?? 0), 0);
  const lines = [
    msg('cli.doctor.processes', {
      cores: fact.cores,
      budget: fact.cpuBudget ?? msg('cli.doctor.processesUndeclared'),
    }),
    ...fact.roles.map((entry) =>
      'refused' in entry.resolved
        ? msg('cli.doctor.processesRefused', {
            role: entry.role,
            code: entry.resolved.refused.code,
          })
        : msg('cli.doctor.processesRole', {
            role: entry.role,
            count: entry.resolved.count,
            binding: entry.resolved.binding,
            pool: entry.pool,
            listen: entry.listen * entry.resolved.count,
            connections: connectionsOf(entry) ?? 0,
          }),
    ),
    ...(fact.maxConnections === undefined
      ? []
      : [
          msg('cli.doctor.processesConnections', { total: perContainer, max: fact.maxConnections }),
        ]),
  ];
  const processes: JsonValue = {
    environment: fact.environment,
    cores: fact.cores,
    cpuBudget: fact.cpuBudget ?? null,
    migrateReq: fact.migrateReq ?? null,
    roles: fact.roles.map(roleJson),
    connectionsOneOfEach: perContainer,
    maxConnections: fact.maxConnections ?? null,
  };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), processes },
    lines: [...(result.lines ?? []), ...lines],
  };
}
