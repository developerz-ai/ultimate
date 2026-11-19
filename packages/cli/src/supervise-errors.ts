// The refusals a production container's process count can meet: the count itself, the role, the
// state the children would not share, the pool they split, the platform, and a child that keeps
// crashing. Beside their throwers (`supervise-count.ts`, `supervise.ts`), one class per condition.

import type { Role } from '@ultimat3/core';
import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';

/** The variable every fix below edits: one spelling. */
export const PROCESSES_ENV = 'ULTIMATE_PROCESSES';

export class ProcessesInvalidError extends UltimateError {
  constructor(raw: string) {
    super({
      code: 'X_PROCESSES_INVALID',
      cause: `${PROCESSES_ENV}=${renderCauseValue(raw)} is neither auto nor a positive whole number, so the container cannot tell how many processes to start`,
      fix: `${PROCESSES_ENV}=auto   # in this service's deploy environment, or a positive whole number such as 2`,
    });
  }
}

export class ProcessesRoleSingletonError extends UltimateError {
  constructor(input: { readonly role: Role; readonly requested: number }) {
    super({
      code: 'X_PROCESSES_ROLE_SINGLETON',
      cause: `${PROCESSES_ENV}=${String(input.requested)} on ROLE=${input.role}, which holds a leader lease, a replication slot or runs once — a second process is idle at best`,
      fix: `${PROCESSES_ENV}=1   # in the environment of the ${input.role} service`,
      meta: { role: input.role, requested: input.requested },
    });
  }
}

export class ProcessesUnsharedStateError extends UltimateError {
  constructor(input: { readonly requested: number; readonly reasons: readonly string[] }) {
    super({
      code: 'X_PROCESSES_UNSHARED_STATE',
      cause: `${PROCESSES_ENV}=${String(input.requested)} over state each child would keep to itself: ${input.reasons.join('; ')}`,
      fix: `${PROCESSES_ENV}=1   # or share the state: NATS_URL=nats://<host>:4222 (REDIS_URL for the cache), DATABASE_URL for an embedded database, and drop the per-process store from apps/<app>/runtime.ts`,
      meta: { requested: input.requested, reasons: [...input.reasons] },
    });
  }
}

export class ProcessesOverPoolError extends UltimateError {
  constructor(input: { readonly requested: number; readonly pool: number }) {
    super({
      code: 'X_PROCESSES_OVER_POOL',
      cause: `${PROCESSES_ENV}=${String(input.requested)} is more than the container's ${String(input.pool)} database connections (DATABASE_POOL_MAX, else the role's profile): the pool is split across the children, never multiplied, so a child would get none`,
      fix: `DATABASE_POOL_MAX=${renderFixShellArg(String(input.requested), '<processes>')}   # or ${PROCESSES_ENV}=${String(input.pool)}`,
      meta: { requested: input.requested, pool: input.pool },
    });
  }
}

export class ProcessesUnbalancedError extends UltimateError {
  constructor(input: { readonly requested: number; readonly platform: string }) {
    super({
      code: 'X_PROCESSES_UNBALANCED',
      cause: `${PROCESSES_ENV}=${String(input.requested)} on ${renderCauseValue(input.platform)}, where Bun ignores reusePort (SO_REUSEPORT is Linux only), so the children cannot share one port`,
      fix: `${PROCESSES_ENV}=1   # or run the image in a Linux container`,
      meta: { requested: input.requested, platform: input.platform },
    });
  }
}

export class ProcessCrashLoopError extends UltimateError {
  constructor(input: {
    readonly index: number;
    readonly code: number | null;
    readonly crashes: number;
    readonly windowMs: number;
  }) {
    const exit = input.code === null ? 'was killed' : `exited ${String(input.code)}`;
    super({
      code: 'X_PROCESS_CRASH_LOOP',
      cause: `child ${String(input.index)} ${exit}, its ${String(input.crashes)}th unexpected exit within ${String(Math.round(input.windowMs / 60_000))} minutes, so the supervisor drained its siblings and the container exits 1 for the platform to restart`,
      fix: `docker compose logs --tail 200 <service>   # the last error line with "child":${String(input.index)} names the boot error to fix`,
      meta: { child: input.index, exitCode: input.code, crashes: input.crashes },
    });
  }
}
