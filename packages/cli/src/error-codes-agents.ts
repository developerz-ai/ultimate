// The X_* codes of agents sharing one machine and repository: a checkout, port or app another
// process holds, a ledger wait given up, a half-done merge, a catalog a merge broke, a doctor check
// that threw. Split from `error-codes.ts` at its ceiling, which folds these into the CLI's one owned
// union and registers them in its one call; nothing else imports this file.

/** Codes `x dev`, `x upgrade`, `x heavy`, `x merge-driver`, `x doctor` and the catalog loader own. */
export const CLI_AGENTS_ERROR_CODES = [
  'X_DEV_ALREADY_RUNNING',
  // The OTHER thing the preflight can find, and it was reported as the one above: an unreadable
  // lock this process could not remove made `DevAlreadyRunningError` name THIS pid as the holder,
  // so the remedy printed was `kill <self>` — unrunnable, and a cause that was simply untrue.
  'X_DEV_LOCK_UNREADABLE',
  'X_PORT_IN_USE',
  'X_UPGRADE_LOCKED',
  'X_HEAVY_WAIT_EXPIRED',
  'X_MERGE_UNRESOLVED',
  'X_MERGE_DRIVER_UNSET',
  'X_CATALOG_UNPARSEABLE',
  'X_DOCTOR_PROBE_FAILED',
] as const;

export type CliAgentsErrorCode = (typeof CLI_AGENTS_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_AGENTS_ERROR_TITLES: Readonly<Record<CliAgentsErrorCode, string>> = {
  X_DEV_ALREADY_RUNNING: 'another x dev already owns this checkout',
  X_DEV_LOCK_UNREADABLE: 'the dev lock file cannot be read or removed',
  X_PORT_IN_USE: 'the dev port is taken',
  X_UPGRADE_LOCKED: 'another x upgrade holds this app',
  X_HEAVY_WAIT_EXPIRED: 'x heavy run stopped waiting for the machine ledger',
  X_MERGE_UNRESOLVED: 'a merge left conflicts in the app',
  X_MERGE_DRIVER_UNSET: 'the merge drivers .gitattributes names are not configured',
  X_CATALOG_UNPARSEABLE: 'an i18n catalog is not valid JSON',
  X_DOCTOR_PROBE_FAILED: 'one x doctor check could not run',
};
