// The X_* codes of processes per container (`ULTIMATE_PROCESSES`): the count's refusals, the
// supervisor's crash loop and `x doctor`'s two warnings — split out of `error-codes.ts` at its
// 500-line ceiling. `error-codes.ts` folds these into the CLI's one owned union and registers them
// in its one call; nothing else imports this file.

/** Codes the supervisor (`supervise*.ts`) and `doctor-processes.ts` declare and own. */
export const CLI_PROCESSES_ERROR_CODES = [
  'X_PROCESSES_INVALID',
  'X_PROCESSES_ROLE_SINGLETON',
  'X_PROCESSES_UNSHARED_STATE',
  'X_PROCESSES_OVER_POOL',
  'X_PROCESSES_UNBALANCED',
  'X_PROCESS_CRASH_LOOP',
  'X_PROCESSES_CPU_UNDECLARED',
  'X_PROCESSES_MIGRATE_REQ_OFF',
] as const;

export type CliProcessesErrorCode = (typeof CLI_PROCESSES_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_PROCESSES_ERROR_TITLES: Readonly<Record<CliProcessesErrorCode, string>> = {
  X_PROCESSES_INVALID: 'ULTIMATE_PROCESSES is not auto or a count',
  X_PROCESSES_ROLE_SINGLETON: 'this role runs as one process per container',
  X_PROCESSES_UNSHARED_STATE: 'more than one process over per-process state',
  X_PROCESSES_OVER_POOL: 'more processes than database pool connections',
  X_PROCESSES_UNBALANCED: 'SO_REUSEPORT does not balance on this platform',
  X_PROCESS_CRASH_LOOP: 'a child process kept crashing',
  X_PROCESSES_CPU_UNDECLARED: 'no CPU budget declared on a multi-core host',
  X_PROCESSES_MIGRATE_REQ_OFF: 'shared-port listeners reset queued connections',
};
