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
export { bulkChannel, channel, isBulkChannel } from './channel';
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
export { createMemoryDigestStore } from './digest';
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
export { createMemoryInboxStore, DEFAULT_INBOX_PAGE } from './inbox';
export type { InboxPurgeBefore, PgInboxStore, PgInboxStoreOptions } from './inbox-pg';
export {
  createPgInboxStore,
  SQL_NOTIFY_INBOX_ADD,
  SQL_NOTIFY_INBOX_MARK_READ,
  SQL_NOTIFY_INBOX_MARK_SEEN,
  SQL_NOTIFY_INBOX_PAGE,
  SQL_NOTIFY_INBOX_PURGE,
  SQL_NOTIFY_INBOX_TABLE,
  SQL_NOTIFY_INBOX_UNREAD,
} from './inbox-pg';
export type {
  DeliveryClaim,
  DeliveryLedger,
  DeliveryRecord,
  DeliveryStatus,
  MemoryDeliveryLedger,
  MemoryLedgerOptions,
} from './ledger';
export {
  createMemoryDeliveryLedger,
  DEFAULT_MAX_DELIVERY_RECORDS,
  DELIVERY_STATUSES,
  isDeliveryStatus,
} from './ledger';
export type { PgDeliveryLedger, PgDeliveryLedgerOptions } from './ledger-pg';
export {
  createPgDeliveryLedger,
  DEFAULT_DELIVERY_WINDOW_MS,
  SQL_NOTIFY_CLAIM,
  SQL_NOTIFY_DELIVERIES_PURGE,
  SQL_NOTIFY_DELIVERIES_TABLE,
  SQL_NOTIFY_FIND,
  SQL_NOTIFY_SETTLE,
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
export { allowAllPreferences, createMemoryPreferenceStore } from './preferences';
export { purgeNotifyDeliveries, purgeNotifyInbox } from './retention';
export type { InstalledNotifyStores, NotifyStores } from './stores';
export {
  notifyStores,
  requireDigest,
  requireInbox,
  resetNotifyStores,
  setNotifyStores,
} from './stores';
