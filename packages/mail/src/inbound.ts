// Single responsibility: the public API of `@ultimat3/mail/inbound` — received email. A subpath
// and not the barrel for the reason `events.ts` is one: only an app's receiving route needs SNS or
// Svix verification and a MIME parser, and every serving role loads the barrel to send.

export {
  DEFAULT_INBOUND_PREFIX,
  INBOUND_ATTACHMENT_TYPES,
} from './inbound-attachments';
export { inboundMail } from './inbound-mail';
export type { ResendInboundOptions } from './inbound-resend';
export { resendInbound } from './inbound-resend';
export type { SesInboundOptions } from './inbound-ses';
export { sesInbound } from './inbound-ses';
export type {
  InboundAttachment,
  InboundAttachmentOptions,
  InboundDoor,
  InboundHandleArgs,
  InboundMailDefinition,
  InboundMessage,
  InboundProvider,
  InboundProviderName,
  InboundRow,
} from './inbound-types';
export type { MimeAttachment, MimeLimits, ParsedMime } from './mime-parse';
export { DEFAULT_MIME_LIMITS, parseMime } from './mime-parse';
export type { InboundAddress } from './mime-parse-address';
export type { InboundLimit, InboundMalformation } from './mime-parse-errors';
export type { HeaderField } from './mime-parse-headers';
