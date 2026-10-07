// Public API of @ultimat3/notify. Explicit re-exports only — no `export *`.
//
// ONE entry point, deliberately: every module here runs on the server. There is no browser half to
// split off, because the only client-side surface a notification has is the inbox rendered by a
// page and the socket `@ultimat3/realtime` already owns.

/** Re-exported so a `notifier` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { AttemptInput } from './attempt';
export { attemptDelivery } from './attempt';
export type {
  AnyNotifyChannel,
  BulkDeliveryArgs,
  BulkNotifyChannel,
  DeliveryArgs,
  NotifyChannel,
} from './channel';
export { bulkChannel, deliveryChannel, isBulkChannel } from './channel';
export type { InAppChannelOptions } from './channel-in-app';
export { IN_APP_CHANNEL, inAppChannel } from './channel-in-app';
export type { MailChannelOptions, Mailer, NotifyMail } from './channel-mail';
export { MAIL_CHANNEL, mailChannel } from './channel-mail';
export type {
  DigestAppend,
  DigestBucket,
  DigestSlot,
  DigestStore,
  MemoryDigestStore,
} from './digest';
export { memoryDigestStore } from './digest';
export type { PostgresDigestStore, PostgresDigestStoreOptions } from './digest-pg';
export {
  DEFAULT_DIGEST_RETENTION_MS,
  postgresDigestStore,
  SQL_NOTIFY_DIGESTS_TABLE,
} from './digest-pg';
export type { NotifyErrorCode } from './errors';
export {
  NOTIFY_ERROR_CODES,
  NotifyChannelDuplicateError,
  NotifyChannelsEmptyError,
  NotifyDeliveryFailedError,
  NotifyDigestUnsupportedError,
  NotifyFanoutTooWideError,
  NotifyStoreMissingError,
} from './errors';
// `runFanout` is deliberately absent, for the reason `registerJob` is absent from
// @ultimat3/jobs: a second way to execute a fan-out would bypass the job the factory built, and
// with it the retry policy, the cancellation and the manifest row.
export type { InboxQuery, InboxRow, InboxStore, InboxWrite, MemoryInboxStore } from './inbox';
export { DEFAULT_INBOX_PAGE, memoryInboxStore } from './inbox';
export type { InboxPurgeBefore, PostgresInboxStore, PostgresInboxStoreOptions } from './inbox-pg';
export {
  postgresInboxStore,
  SQL_NOTIFY_INBOX_TABLE,
} from './inbox-pg';
export type {
  DeliveryClaim,
  DeliveryLedger,
  DeliveryRecord,
  DeliveryStatus,
  MemoryDeliveryLedger,
  MemoryDeliveryLedgerOptions,
} from './ledger';
export {
  DELIVERY_STATUSES,
  isDeliveryStatus,
  memoryDeliveryLedger,
} from './ledger';
export type { PostgresDeliveryLedger, PostgresDeliveryLedgerOptions } from './ledger-pg';
export {
  postgresDeliveryLedger,
  SQL_NOTIFY_DELIVERIES_TABLE,
} from './ledger-pg';
export type { NotifyEvent, Recipient } from './notification';
export { recipientSchema } from './notification';
export type { NotifierDefinition } from './notifier';
export { DEFAULT_MAX_RECIPIENTS, notifier } from './notifier';
export type {
  ChannelDelivery,
  DeliveryGate,
  DigestWindow,
  NotifyDuration,
  NotifyPayload,
  NotifyPlan,
  NotifyReport,
  RecipientArgs,
  ResolvedDelivery,
} from './plan';
export { toDurationMs } from './plan';
export type { MemoryPreferenceStore, PreferenceQuery, PreferenceStore } from './preferences';
export { allowAllPreferences, memoryPreferenceStore } from './preferences';
export { purgeNotifyDeliveries, purgeNotifyDigests, purgeNotifyInbox } from './retention';
export type { InstalledNotifyStores, NotifyStores } from './stores';
export {
  notifyStores,
  requireInbox,
  resetNotifyStores,
  setNotifyStores,
} from './stores';
