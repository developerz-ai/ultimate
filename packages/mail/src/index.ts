// Single responsibility: the public API of @ultimat3/mail. Explicit named exports only —
// other packages call `defineMail`, `send` and the driver seam, and nothing else.

/** Re-exported so a `defineMail` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { CalloutTone, MailBlock, MailTemplate, TemplateArgs } from './blocks';
export { blocks } from './blocks';
export { MAIL_CATALOG } from './catalog';
// Type-only, so a sender can name an event without loading a receiver; the receivers are
// `@ultimat3/mail/events`, kept off the barrel every serving role evaluates.
export type { DeliveryEvent } from './delivery-event';
export type {
  MailDriver,
  MailMessage,
  MemoryMailDriver,
  MemoryMailDriverOptions,
  SendResult,
  SentMail,
} from './driver';
export {
  isMemoryDriver,
  isUnconfiguredDriver,
  logMailDriver,
  mailDriver,
  memoryMailDriver,
  messageHeaders,
  tryMailDriver,
  unconfiguredMailDriver,
} from './driver';
export type { MailEnvironment, MailSelection, MailSelectOptions } from './driver-env';
export { selectMailDriver } from './driver-env';
export type { MailFetch, ResendDriverOptions } from './driver-resend';
export { resendMailDriver } from './driver-resend';
export type { SesDriverOptions } from './driver-ses';
export { sesMailDriver } from './driver-ses';
export type { SmtpDriverOptions } from './driver-smtp';
export { smtpMailDriver } from './driver-smtp';
export { assertEnvelopeAddress } from './envelope-address';
export type { EnvelopeAddressField, MailErrorCode, MailErrorInit, SendStage } from './errors';
export { driverUnavailable, MailError, mailKeyMissing, sendFailed } from './errors';
export { assertHeaderSafe } from './header-safety';
export { safeMailHref } from './html';
export { mailIdempotencyKey, mailMessageIdToken } from './idempotency';
export { mailMessageSchema, sendMailJob } from './job';
export type {
  ColorScheme,
  LayoutInput,
  LayoutRegistration,
  MailLayout,
  MailToken,
  UnsubscribeSlot,
} from './layout';
export {
  layoutFor,
  MAIL_TOKENS,
  registeredLayouts,
  registerLayout,
  restoreLayouts,
  token,
} from './layout';
export type { AnyMailDefinition, MailDefinition, MailInit, MailPreview, SendOptions } from './mail';
export {
  defineMail,
  mailFor,
  registeredMailIds,
  registeredMails,
  renderMessage,
  resetMails,
  restoreMails,
  send,
} from './mail';
export type { MailPreviewResult, PreviewOptions } from './preview';
export { previewableMailIds, previewMail } from './preview';
export type { RenderableMail, RenderedMail, RenderOptions } from './render';
export { renderMail, textOf } from './render';
export type { RetainedMime, RetainedMimeEntry, RetainMimeOptions } from './retain-mime';
export { DEFAULT_RETAIN_MIME_MAX_BYTES, RETAIN_MIME_CEILING_BYTES } from './retain-mime';
export type { SmtpConnector, SmtpStream } from './smtp-client';
export type { MailRendered, MailTransform, MailTransformMeta } from './transform';
export { setMailTransform } from './transform';
