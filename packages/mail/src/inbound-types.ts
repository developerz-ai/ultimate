// Single responsibility: the shapes `inboundMail()` speaks — the typed message a handler receives,
// its attachments as storage references, the provider port each inbound format implements, and
// the declaration. Apart from the factory so each file keeps one job.

import type { Ctx } from '@ultimat3/core';
import type { WebhookHandleArgs, WebhookInbound, WebhookReceiverDefinition } from '@ultimat3/jobs';
import type { StorageDriver, UploadPolicy } from '@ultimat3/storage';
import type { MimeLimits } from './mime-parse';
import type { InboundAddress } from './mime-parse-address';
import type { HeaderField } from './mime-parse-headers';

/** What jobs' `verify` is handed: the request's exact bytes and headers. */
export type { WebhookInbound };

export type InboundProviderName = 'ses' | 'resend';

interface InboundAttachmentBase {
  /** SENDER-CONTROLLED and unsanitised: never a path, never unescaped into HTML. */
  readonly filename: string | undefined;
  /** As the sender declared it. */
  readonly declaredType: string;
  readonly size: number;
  /** SENDER-CONTROLLED and unsanitised (`cid:` references in `html`). */
  readonly contentId: string | undefined;
  readonly inline: boolean;
}

/**
 * Stored: the bytes are at `key`, under the type the sniff agreed with. Not stored: `refusal` is
 * storage's `X_STORAGE_*` code, `X_MAIL_INBOUND_MALFORMED` for a part whose transfer encoding did
 * not decode, `'verdict'` for an SES virus FAIL, or `'disabled'` under `attachments: false` — the message still arrives: one bad file
 * never loses the mail around it.
 */
export type InboundAttachment =
  | (InboundAttachmentBase & {
      readonly stored: true;
      readonly key: string;
      readonly contentType: string;
      /** base64 SHA-256 of the stored bytes. */
      readonly checksum: string;
    })
  | (InboundAttachmentBase & { readonly stored: false; readonly refusal: string });

export interface InboundMessage {
  readonly provider: InboundProviderName;
  /** The provider's id for this message, and the receiver's dedupe key. */
  readonly eventId: string;
  /**
   * Who the provider says the message was delivered to, from its signed payload — never a header.
   * SES: the receipt's recipients, the SMTP envelope, Bcc included. Resend: its `to`, which Resend
   * does not document as the envelope: route only on addresses of your own receiving domain.
   */
  readonly recipients: readonly string[];
  readonly messageId: string | undefined;
  readonly from: InboundAddress | undefined;
  readonly to: readonly InboundAddress[];
  readonly cc: readonly InboundAddress[];
  readonly replyTo: readonly InboundAddress[];
  readonly subject: string;
  /** The `Date:` header as an instant, or `undefined` when absent or unreadable. */
  readonly date: Date | undefined;
  readonly text: string | undefined;
  /**
   * SENDER-CONTROLLED and unsanitised — scripts, trackers, forms. Never render it on the app's own
   * origin; show it in a sandboxed frame or reduce it to text.
   */
  readonly html: string | undefined;
  /** Every top-level header in order, decoded — `Received` repeats, so never a record. */
  readonly headers: readonly HeaderField[];
  readonly attachments: readonly InboundAttachment[];
  /** The provider's spam/virus/SPF/DKIM/DMARC verdicts, as it spelled them, when it sent any. */
  readonly verdicts: Readonly<Record<string, string>>;
}

/** The queue row: what the door read out of the VERIFIED body. JSON, `.sensitive()` in the row. */
export type InboundRow =
  | {
      readonly provider: 'ses';
      readonly recipients: readonly string[];
      readonly content: string;
      readonly encoding: 'BASE64' | 'UTF8';
      readonly verdicts: { readonly [name: string]: string };
    }
  | {
      readonly provider: 'resend';
      readonly recipients: readonly string[];
      readonly emailId: string;
    };

/** What a provider's door answers: a message to queue, or its own protocol's response. */
export type InboundDoor =
  | { readonly eventId: string; readonly row: InboundRow }
  | { readonly answer: Response };

/** One inbound format. Built by `sesInbound()` / `resendInbound()`, which refuse config at boot. */
export interface InboundProvider {
  readonly name: InboundProviderName;
  /** Signature FIRST, over the exact bytes; only then is anything parsed. */
  door(inbound: WebhookInbound): Promise<InboundDoor>;
  /** The raw RFC 5322 bytes: from the row (SES), or the provider's API (Resend). */
  mime(row: InboundRow, maxBytes: number): Promise<Uint8Array>;
}

export interface InboundAttachmentOptions {
  /** Absent: the app's default disk, resolved per message. */
  readonly disk?: (() => StorageDriver) | undefined;
  /** Default `uploadPolicy({ maxBytes: 10 MiB, allowedContentTypes: INBOUND_ATTACHMENT_TYPES })`. */
  readonly policy?: UploadPolicy | undefined;
  /** Default `'inbound-mail'`; under `org/<orgId>/` when the receiver is tenanted. */
  readonly prefix?: string | undefined;
  /**
   * Store a message's attachments even when the provider's virus verdict is `FAIL`. Default false:
   * each arrives `stored: false`, refusal `'verdict'` — `handle` still sees the message and the
   * verdict, and nothing infected reaches a disk a `/_storage` route can serve.
   */
  readonly keepOnVirusFail?: boolean | undefined;
}

export interface InboundHandleArgs {
  readonly message: InboundMessage;
  readonly orgId: string | undefined;
  readonly ctx: Ctx;
  readonly step: WebhookHandleArgs['step'];
  readonly attempt: number;
}

export interface InboundMailDefinition {
  /** The job's durable name. */
  readonly name: string;
  /** Absolute, outside `/api` and `/_x` — jobs' `webhookReceiver()` rule. */
  readonly path: string;
  /**
   * A thunk, built on the first delivery and kept: a provider's credentials are environment only
   * the receiving role holds, and every role imports this declaration. A throw (`X_CONFIG_INVALID`
   * for an unset secret) answers that delivery and is asked again on the next one.
   */
  readonly provider: () => InboundProvider;
  /** The webhook body's ceiling, enforced while it streams. Default 1 MiB (SNS caps at 256 KiB). */
  readonly maxBodyBytes?: number | undefined;
  /** `'none'`, or the org a message belongs to, from `InboundMessage.recipients`' rule. */
  readonly tenant: 'none' | ((recipients: readonly string[]) => string | undefined);
  /** At least once per message: key your own writes on `message.eventId`. */
  handle(args: InboundHandleArgs): Promise<unknown>;
  /** Defaults to `DEFAULT_MIME_LIMITS`. */
  readonly limits?: Partial<MimeLimits> | undefined;
  /** `false` stores nothing: every attachment arrives `stored: false`, refusal `'disabled'`. */
  readonly attachments?: InboundAttachmentOptions | false | undefined;
  readonly retry?: WebhookReceiverDefinition['retry'];
  readonly queue?: string | undefined;
  readonly rateLimit?: WebhookReceiverDefinition['rateLimit'];
}
