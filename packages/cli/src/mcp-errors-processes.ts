// `errors.explain`'s rows for processes per container (`ULTIMATE_PROCESSES`) — the supervisor's
// family, split out of `mcp-errors.ts` under the 500-line ceiling. Spread into `CLI_FIXES` there,
// whose `Record<CliErrorCode, string>` is still what makes a code without a row a build error.

import type { CliErrorCode } from './error-codes';

export const PROCESSES_FIXES = {
  X_PROCESSES_INVALID:
    'ULTIMATE_PROCESSES=auto   # in the deploy environment of this service, or a positive whole number such as 2',
  X_PROCESSES_ROLE_SINGLETON:
    'ULTIMATE_PROCESSES=1   # in the environment of the scheduler, replicator and migrate services',
  X_PROCESSES_UNSHARED_STATE:
    "ULTIMATE_PROCESSES=1   # or share the state: set NATS_URL (REDIS_URL for the cache) and drop the per-process store from the app's runtime.ts; the error lists each",
  X_PROCESSES_OVER_POOL:
    'ULTIMATE_PROCESSES=1   # or raise DATABASE_POOL_MAX to at least the count; the error names both numbers',
  X_PROCESSES_UNBALANCED: 'ULTIMATE_PROCESSES=1   # or run the image in a Linux container',
  X_PROCESS_CRASH_LOOP:
    'docker compose logs --tail 200   # the last error line with the crashing child index names the boot error to fix',
  X_PROCESSES_CPU_UNDECLARED:
    "cpus: '2'   # on the role's service in docker/docker-compose.prod.yml",
  X_PROCESSES_MIGRATE_REQ_OFF:
    'sysctls: { net.ipv4.tcp_migrate_req: 1 }   # on the service in docker/docker-compose.prod.yml',
} as const satisfies Partial<Record<CliErrorCode, string>>;
