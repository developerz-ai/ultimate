// Single responsibility: the public API of @ultimat3/mail. Explicit named exports only —
// other packages call `defineMail`, `send` and the driver seam, and nothing else.

/** Re-exported so a `defineMail` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { CalloutTone, MailBlock, MailTemplate, TemplateArgs } from './blocks';
export { blocks } from './blocks';

export { MAIL_CATALOG, MAIL_CATALOG_LOCALE } from './catalog';
export type {
  MailDriver,
  MailMessage,
  MemoryMailDriver,
  MemoryMailDriverOptions,
  SendResult,
  SentMail,
} from './driver';
export {
  createLogDriver,
  createMemoryDriver,
  createUnconfiguredDriver,
  isMemoryDriver,
  isUnconfiguredDriver,
  mailDriver,
  messageHeaders,
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
} from './driver';
export type { MailEnvironment, MailSelection } from './driver-env';
export { selectMailDriver } from './driver-env';
export type { MailFetch, ResendDriverOptions } from './driver-resend';
export { createResendDriver } from './driver-resend';
export type { SmtpDriverOptions } from './driver-smtp';
export { createSmtpDriver } from './driver-smtp';
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
} from './errors';
export { assertHeaderSafe } from './header-safety';

export { escapeHtml, safeUrl } from './html';

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
