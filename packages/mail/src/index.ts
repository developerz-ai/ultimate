// Single responsibility: the public API of @ultimat3/mail. Explicit named exports only —
// other packages call `defineMail`, `send` and the driver seam, and nothing else.

export { escapeHtml } from '@ultimat3/core';
/** Re-exported so a `defineMail` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { CalloutTone, MailBlock, MailTemplate, TemplateArgs } from './blocks';
export { blocks } from './blocks';
export { MAIL_CATALOG, MAIL_CATALOG_LOCALE } from './catalog';
// Type-only, so a sender can name an event without loading a receiver; the receivers are
// `@ultimat3/mail/events`, kept off the barrel every serving role evaluates.
export type {
  DeliveryEvent,
  DeliveryEventKind,
  DeliveryOutcome,
  DeliveryReceiver,
} from './delivery-event';
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
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
  unconfiguredMailDriver,
} from './driver';
export type { MailEnvironment, MailSelection, MailSelectOptions } from './driver-env';
export { selectMailDriver } from './driver-env';
export type { MailFetch, ResendDriverOptions } from './driver-resend';
export { resendMailDriver } from './driver-resend';
export type { SesDriverOptions } from './driver-ses';
export { sesEndpoint, sesMailDriver } from './driver-ses';
export type { SmtpDriverOptions } from './driver-smtp';
export { smtpMailDriver } from './driver-smtp';
export { assertEnvelopeAddress } from './envelope-address';
export type {
  AddressRefusal,
  EnvelopeAddressField,
  MailErrorCode,
  MailErrorInit,
  SendFailure,
  SendStage,
} from './errors';
export {
  addressInvalid,
  driverUnavailable,
  layoutUnknown,
  localeMissing,
  MAIL_ERROR_CODES,
  MAIL_ERROR_RETRY,
  MAIL_ERROR_TITLES,
  MailError,
  mailCredentialMissing,
  mailDuplicate,
  mailLayoutDuplicate,
  sendFailed,
  templateUnknown,
  textMissing,
  transformFailed,
} from './errors';
export { assertHeaderSafe } from './header-safety';
export { safeUrl } from './html';

export { mailIdempotencyKey, mailMessageIdToken } from './idempotency';
export { mailMessageSchema, sendMailJob } from './job';
export type {
  ColorScheme,
  DarkRule,
  LayoutInput,
  MailLayout,
  MailToken,
  UnsubscribeSlot,
} from './layout';
export {
  BASE_LAYOUT,
  baseLayout,
  layoutFor,
  MAIL_TOKENS,
  registeredLayouts,
  registerLayout,
  token,
} from './layout';
export type { AnyMailDefinition, MailDefinition, MailInit, SendOptions } from './mail';
export {
  defineMail,
  mailFor,
  registeredMailIds,
  registeredMails,
  renderMessage,
  resetMails,
  send,
  sendById,
} from './mail';
export type { RenderableMail, RenderedMail, RenderOptions } from './render';
export { renderMail, textOf } from './render';
export type { RetainedMime, RetainedMimeEntry, RetainMimeOptions } from './retain-mime';
export { DEFAULT_RETAIN_MIME_MAX_BYTES, RETAIN_MIME_CEILING_BYTES } from './retain-mime';
export type { SmtpConnector, SmtpStream } from './smtp-client';
export {
  FRAMEWORK_MAILS,
  type InviteInput,
  inviteInput,
  inviteMail,
  MFA_METHODS,
  type MfaEnrolledInput,
  mfaEnrolledInput,
  mfaEnrolledMail,
  type ResetPasswordInput,
  resetPasswordInput,
  resetPasswordMail,
  type SecurityAlertInput,
  securityAlertInput,
  securityAlertMail,
  type VerifyEmailInput,
  verifyEmailInput,
  verifyEmailMail,
  type WelcomeInput,
  welcomeInput,
  welcomeMail,
} from './templates';
export type { MailRendered, MailTransform, MailTransformMeta } from './transform';
export { mailTransform, setMailTransform } from './transform';
