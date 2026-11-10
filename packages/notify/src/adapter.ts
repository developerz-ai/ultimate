// `@ultimat3/notify/adapter` — what a notifier's stores and its SMS transport are built and
// installed from: the port interfaces, the errors a driver raises, and the boot's installers. Never the
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
export { NotifySmsNumberInvalidError, NotifySmsTransportMissingError } from './sms-errors';
export type { SmsMessage, SmsSendResult, SmsTransport } from './sms-transport';
export { installSmsTransport, resetSmsTransport } from './sms-transport';
export type { InstalledNotifyStores, NotifyStores } from './stores';
export { installNotifyStores, resetNotifyStores } from './stores';
