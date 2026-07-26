// Single responsibility: the public API of @ultimat3/mail. Explicit named exports only —
// other packages call `defineMail`, `send` and the driver seam, and nothing else.

export type { CalloutTone, MailBlock, MailTemplate, TemplateArgs } from './blocks';
export { blocks } from './blocks';

export { MAIL_CATALOG, MAIL_CATALOG_SOURCE, registerMailCatalog } from './catalog';
export type {
  MailDriver,
  MailMessage,
  MemoryMailDriver,
  ResendDriverOptions,
  SendResult,
  SentMail,
  SmtpDriverOptions,
} from './driver';
export {
  createLogDriver,
  createMemoryDriver,
  createResendDriver,
  createSmtpDriver,
  mailDriver,
  messageHeaders,
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
} from './driver';
export type { MailErrorCode, MailErrorInit } from './errors';
export {
  driverUnavailable,
  layoutUnknown,
  localeMissing,
  MAIL_ERROR_CODES,
  MAIL_ERROR_TITLES,
  MailError,
  mailDuplicate,
  templateUnknown,
  textMissing,
  transportNotImplemented,
} from './errors';

export { escapeHtml, safeUrl } from './html';

export { mailIdempotencyKey, mailMessageSchema, sendMailJob } from './job';
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
  DARK_RULES,
  darkModeCss,
  layoutFor,
  MAIL_FONT_STACK,
  MAIL_TOKENS,
  MAIL_WIDTH_PX,
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
export { FOOTER_KEYS, renderMail, textOf, UNSUBSCRIBE_KEY } from './render';

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
