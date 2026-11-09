// The four seams a fan-out reads, installed once per process. Same shape as `installJobDriver` in
// @ultimat3/jobs/adapter and for the same reason: a notifier is declared at import time, long before a
// boot has a database, so the store cannot be a constructor argument.
//
// One installer, never four. Handing them over in one call is what makes "the ledger is Postgres
// but the inbox is still the memory one" a visible line of code rather than a forgotten fifth call.

import { adapterSlot } from '@ultimat3/core/adapter';
import type { DigestStore } from './digest';
import { NotifyStoreMissingError } from './errors';
import type { InboxStore } from './inbox';
import type { DeliveryLedger } from './ledger';
import { memoryDeliveryLedger } from './ledger';
import type { PreferenceStore } from './preferences';
import { allowAllPreferences } from './preferences';

export interface NotifyStores {
  /**
   * Defaults to `memoryDeliveryLedger()`. A default is correct here and nowhere else in this
   * interface: one process with one replica is genuinely deduped by a heap map, and the failure
   * mode of having none at all — a replayed attempt sending twice — is worse than the failure mode
   * of a dev default, which is a second send only after a restart.
   */
  readonly ledger?: DeliveryLedger | undefined;
  /** No default: a channel that writes the inbox refuses rather than dropping the row. */
  readonly inbox?: InboxStore | undefined;
  /** Defaults to `allowAllPreferences()` — `noticed`'s behaviour, and the safe one for a boot
   * that has not written a preferences table yet. Denying by default would mean a notifier that
   * silently delivers nothing, whose first symptom is a missing email. */
  readonly preferences?: PreferenceStore | undefined;
  /** No default: a digest window has nowhere to coalesce into. */
  readonly digest?: DigestStore | undefined;
}

export interface InstalledNotifyStores {
  readonly ledger: DeliveryLedger;
  readonly inbox: InboxStore | undefined;
  readonly preferences: PreferenceStore;
  readonly digest: DigestStore | undefined;
}

const defaults = (): InstalledNotifyStores => ({
  ledger: memoryDeliveryLedger(),
  inbox: undefined,
  preferences: allowAllPreferences(),
  digest: undefined,
});

let base: InstalledNotifyStores = defaults();
/** The installed stores: a stack over the defaults, released in any order. */
const slot = adapterSlot<InstalledNotifyStores>(() => base);

/**
 * The boot's installer (its release removes THIS install only, in any order — `adapterSlot`), on `@ultimat3/notify/adapter` and never the `.` barrel: an app hands its
 * stores over with `notifyStores:` in `apps/<app>/runtime.ts`. Whole-object replacement, never a
 * merge: two calls with different halves is the split-brain `RuntimeOverrides` exists to refuse,
 * and a merge would hide the second call's omissions.
 */
export function installNotifyStores(stores: NotifyStores): () => void {
  return slot.install({
    ledger: stores.ledger ?? memoryDeliveryLedger(),
    inbox: stores.inbox,
    preferences: stores.preferences ?? allowAllPreferences(),
    digest: stores.digest,
  });
}

export const notifyStores = (): InstalledNotifyStores => slot.current();

/** Tests only — the same escape `resetJobDriver` offers, so one suite cannot leak into the next. */
export function resetNotifyStores(): void {
  slot.reset();
  base = defaults();
}

/** The inbox, or the refusal that names the install call. Never an optional chain at the call
 * site: a silently skipped inbox write is a notification the user never sees and nobody logs. */
export function requireInbox(notifier: string): InboxStore {
  const store = slot.current().inbox;
  if (store === undefined) throw new NotifyStoreMissingError({ notifier, store: 'inbox' });
  return store;
}

export function requireDigest(notifier: string): DigestStore {
  const store = slot.current().digest;
  if (store === undefined) throw new NotifyStoreMissingError({ notifier, store: 'digest' });
  return store;
}
