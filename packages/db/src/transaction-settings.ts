// Single responsibility: the settings every root transaction begins with — the seam row security
// rides. `@ultimat3/entity` registers the provider (it alone knows the actor's tenant and whether a
// `crossTenant()` scope is open); `withTransaction` asks it once per BEGIN. Same shape as core's
// `currentWriteOrigin`: a value read at the moment of use, never threaded through a parameter.

import type { LocalSettings } from './local-settings';

type SettingsProvider = () => LocalSettings | undefined;

let provider: SettingsProvider | undefined;

/**
 * Install the provider, or `undefined` to remove it. One provider, not a list: two writers of the
 * same setting is a disagreement nobody could see. Unset — every app without row security — costs
 * each BEGIN one comparison and no statement.
 */
export function setTransactionSettings(next: SettingsProvider | undefined): void {
  provider = next;
}

/** What the transaction opening now must set first, or `undefined` for nothing. */
export function transactionSettings(): LocalSettings | undefined {
  return provider?.();
}

/**
 * Whether a provider is installed at all, whatever it answers now. `copy-in.ts` asks: Postgres
 * refuses `COPY FROM` on a table under row-level security (`0A000`) with or without a tenant in
 * scope, so the question is "is row security armed", never "is there a tenant right now".
 */
export function transactionSettingsInstalled(): boolean {
  return provider !== undefined;
}
