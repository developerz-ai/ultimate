// Public API of @ultimat3/notify. Explicit re-exports only — no `export *`.
//
// ONE entry point, deliberately: every module here runs on the server. There is no browser half to
// split off, because the only client-side surface a notification has is the inbox rendered by a
// page and the socket `@ultimat3/realtime` already owns.

/** Re-exported so a `notifier` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { ApnsOptions } from './apns';
export type { AttemptInput } from './attempt';
export { attemptDelivery } from './attempt';
export type {
  AnyNotifyChannel,
  BulkDeliveryArgs,
  BulkNotifyChannel,
  DeliveryArgs,
  NotifyChannel,
} from './channel';
export { bulkChannel, deliveryChannel } from './channel';
export type { InAppChannelOptions } from './channel-in-app';
export { inAppChannel } from './channel-in-app';
export type { MailChannelOptions, Mailer, NotifyMail } from './channel-mail';
export { mailChannel } from './channel-mail';
export type {
  DataPushChannelOptions,
  DataPusher,
  NotifyPushMessage,
  PushChannelOptions,
  Pusher,
} from './channel-push';
export { pushChannel } from './channel-push';
export type {
  DigestAppend,
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
  NotifyChannelDuplicateError,
  NotifyChannelsEmptyError,
  NotifyDeliveryFailedError,
  NotifyDigestUnsupportedError,
  NotifyFanoutTooWideError,
  NotifyStoreMissingError,
} from './errors';
export { NOTIFY_CHUNK_SIZE } from './fanout-walk';
export type { FcmOptions } from './fcm';
// `runFanout` is deliberately absent, for the reason `registerJob` is absent from
// @ultimat3/jobs: a second way to execute a fan-out would bypass the job the factory built, and
// with it the retry policy, the cancellation and the manifest row.
export type { InboxQuery, InboxRow, InboxStore, InboxWrite, MemoryInboxStore } from './inbox';
export { memoryInboxStore } from './inbox';
export type { InboxPurgeBefore, PostgresInboxStore, PostgresInboxStoreOptions } from './inbox-pg';
export {
  postgresInboxStore,
  SQL_NOTIFY_INBOX_TABLE,
} from './inbox-pg';
export type {
  DeliveryClaim,
  DeliveryClaimAnswer,
  DeliveryLedger,
  MemoryDeliveryLedger,
  MemoryDeliveryLedgerOptions,
} from './ledger';
export {
  DEFAULT_DELIVERY_RECLAIM_MS,
  memoryDeliveryLedger,
} from './ledger';
export type { PostgresDeliveryLedger, PostgresDeliveryLedgerOptions } from './ledger-pg';
export {
  postgresDeliveryLedger,
  SQL_NOTIFY_DELIVERIES_TABLE,
} from './ledger-pg';
export type { NativePusher, NativePushOptions } from './native-push';
export {
  nativePush,
  PUSH_BAD_TOKEN_LIMIT,
} from './native-push';
export type { NotifyEvent, Recipient } from './notification';
export type { NotifierDefinition } from './notifier';
export { notifier } from './notifier';
export type {
  ChannelDelivery,
  DeliveryGate,
  DigestWindow,
  NotifyDuration,
  NotifyPayload,
  RecipientArgs,
} from './plan';
export { toDurationMs } from './plan';
export type { MemoryPreferenceStore, PreferenceBatchQuery, PreferenceStore } from './preferences';
export { allowAllPreferences, memoryPreferenceStore } from './preferences';
export type { PushDeviceRecord, PushDeviceStore, PushPlatform } from './push-device';
export { memoryPushDeviceStore } from './push-device';
export type { PostgresPushDeviceStoreOptions } from './push-device-pg';
export {
  PUSH_DEVICES_TABLE,
  postgresPushDeviceStore,
  SQL_PUSH_DEVICES_TABLE,
} from './push-device-pg';
export type { PushProvider } from './push-errors';
export {
  NotifyPushDeviceGoneError,
  NotifyPushMessageInvalidError,
  NotifyPushProviderRefusedError,
} from './push-errors';
export type { PushRegisterOptions } from './push-register';
export { PUSH_DEVICES_PER_ACTOR, pushRegister, pushUnregister } from './push-register';
export { purgeNotifyDeliveries, purgeNotifyDigests, purgeNotifyInbox } from './retention';
// SMS: the reference channel over the `smsTransport` port. The port's interface and installer are
// on `./adapter`; a provider (Twilio, Vonage, SNS) is the app's adapter.
export type { NotifySmsMessage, SmsChannelOptions } from './sms-channel';
export { smsChannel, smsIdempotencyKey } from './sms-channel';
export { NotifySmsNumberInvalidError, NotifySmsTransportMissingError } from './sms-errors';
export type { MemorySmsTransport } from './sms-transport';
export { assertSmsNumber, memorySmsTransport } from './sms-transport';
export type { InstalledNotifyStores, NotifyStores } from './stores';
export {
  notifyStores,
  requireInbox,
} from './stores';
