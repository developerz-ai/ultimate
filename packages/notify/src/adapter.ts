// `@ultimat3/notify/adapter` — what a notifier's stores are built and installed from: the port
// interfaces, the error a missing store raises, and the boot's installer with its reset. Never the
// `.` barrel: an app hands its stores over with `notifyStores:` in `apps/<app>/runtime.ts`, so the
// only callers here are the cli boot, `@ultimat3/testing` and a store author.

export type { DigestAppend, DigestBucket, DigestSlot, DigestStore } from './digest';
export { NotifyStoreMissingError } from './errors';
export type { InboxQuery, InboxRow, InboxStore, InboxWrite } from './inbox';
export type {
  DeliveryClaim,
  DeliveryClaimAnswer,
  DeliveryLedger,
  DeliveryRecord,
  DeliveryStatus,
} from './ledger';
export type { PreferenceBatchQuery, PreferenceStore } from './preferences';
export type { InstalledNotifyStores, NotifyStores } from './stores';
export { installNotifyStores, resetNotifyStores } from './stores';
