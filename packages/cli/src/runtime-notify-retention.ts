// `notify.inboxReadRetentionMs` and `notify.inboxUnreadRetentionMs`, out of the config
// `startServices` loads once (`app-config-load.ts`) — before the app's modules import, so the window
// is read from the file the operator edited, per boot.

import type { AppConfig } from '@ultimat3/core';

/**
 * The two windows in milliseconds, each `undefined` where the app named none.
 *
 * ABSENT IS A DECISION, not a missing default, and it is the only safe one: an inbox row is a
 * message a person has not read yet, so when it disappears is the app's call (axiom 8). The
 * framework picking a number silently is the failure this whole key exists to avoid.
 */
export interface InboxRetention {
  readonly readMs: number | undefined;
  readonly unreadMs: number | undefined;
}

/** Nothing swept — what a boot with no config file, no `notify` section or no keys resolves to. */
export const NO_INBOX_RETENTION: InboxRetention = Object.freeze({
  readMs: undefined,
  unreadMs: undefined,
});

/**
 * Core's validator (through the loader) refuses a window that is not a positive finite number, so
 * a `NaN` cutoff — every row older than it, the inbox emptied on the first pass — cannot reach here.
 */
export function inboxRetentionOf(config: AppConfig | undefined): InboxRetention {
  const notify = config?.notify;
  if (notify === undefined) return NO_INBOX_RETENTION;
  return { readMs: notify.inboxReadRetentionMs, unreadMs: notify.inboxUnreadRetentionMs };
}
