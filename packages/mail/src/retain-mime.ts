// Single responsibility: keeping the exact MIME bytes a transport handed its provider, bounded. The
// two transports that BUILD the message (SMTP, SES) call this once per accepted send; Resend builds
// the MIME on its own side, so there are no bytes here to keep and its driver takes no such option.

import { ConfigInvalidError, finiteCount, logger, renderThrowable } from '@ultimat3/core';
import type { SendResult } from './driver';

/**
 * 256 KiB: a transactional mail with both parts is 5–60 KiB, so this keeps every message this
 * package can render with room to spare, and a process holding a thousand results stays bounded.
 */
export const DEFAULT_RETAIN_MIME_MAX_BYTES = 262_144;

/** The largest cap accepted. Above it a retained message is a memory decision, not an audit one. */
export const RETAIN_MIME_CEILING_BYTES = 10_485_760;

/**
 * What was kept. Over the cap the bytes are DROPPED, never truncated — a truncated message is not
 * the message that was sent, and an audit row claiming otherwise is worse than none. The digest and
 * the length survive either way, so a copy recovered elsewhere can still be proven to be this one.
 */
export type RetainedMime =
  | {
      readonly kind: 'kept';
      /** The RFC 5322 message before SMTP dot-stuffing and before any transfer encoding. */
      readonly raw: string;
      readonly byteLength: number;
      readonly sha256: string;
    }
  | {
      readonly kind: 'digest-only';
      readonly byteLength: number;
      readonly sha256: string;
      /** The cap it exceeded. */
      readonly maxBytes: number;
    };

/** One accepted send's retained bytes, with the ids an audit row is keyed on. */
export interface RetainedMimeEntry {
  readonly mailId: string;
  /** `SendResult.id` — the provider's id, which is what a `DeliveryEvent.messageId` carries. */
  readonly id: string;
  readonly driver: string;
  readonly idempotencyKey: string;
  readonly mime: RetainedMime;
}

export interface RetainMimeOptions {
  /** Default `DEFAULT_RETAIN_MIME_MAX_BYTES`; 1 to `RETAIN_MIME_CEILING_BYTES`. */
  readonly maxBytes?: number | undefined;
  /**
   * The durable half. `SendResult.mime` reaches an inline caller only — a QUEUED send's result is
   * the job run's return value, which the queue does not persist — so the row an auditor reads is
   * written here. Called and NOT awaited; a throw is logged (`mail.retain_mime.failed`) and does
   * NOT fail the send: the message already left, and failing it would have the job send it again.
   */
  readonly onRetained?: ((entry: RetainedMimeEntry) => void | Promise<void>) | undefined;
}

/**
 * Refused at construction, where every other driver option is, and never on the first send — and
 * by `selectMailDriver` before it picks a transport, so the ceiling is one verdict whatever env
 * selects. `key` is where the option was written, named in the refusal: `retainMime` for a call,
 * `mail.retainMime` when a boot read it from `app.config.ts`.
 */
export function resolveRetainMime(
  driver: string,
  options: RetainMimeOptions | undefined,
  key = 'retainMime',
): RetainMimeOptions | undefined {
  if (options === undefined) return undefined;
  const maxBytes = finiteCount(
    driver,
    `${key}.maxBytes`,
    options.maxBytes ?? DEFAULT_RETAIN_MIME_MAX_BYTES,
    1,
  );
  if (maxBytes > RETAIN_MIME_CEILING_BYTES) {
    throw new ConfigInvalidError({
      cause: `${driver} ${key}.maxBytes is ${maxBytes}, above the ${RETAIN_MIME_CEILING_BYTES}-byte ceiling a retained message may hold`,
      fix: `${key}: { maxBytes: ${DEFAULT_RETAIN_MIME_MAX_BYTES} } — or drop maxBytes for that default`,
      meta: { driver, key: `${key}.maxBytes` },
    });
  }
  return { maxBytes, onRetained: options.onRetained };
}

const encoder = new TextEncoder();

/** The bytes as kept, or their digest alone when they exceed the cap. */
export function retainedMime(raw: string, maxBytes: number): RetainedMime {
  const bytes = encoder.encode(raw);
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return bytes.byteLength <= maxBytes
    ? { kind: 'kept', raw, byteLength: bytes.byteLength, sha256 }
    : { kind: 'digest-only', byteLength: bytes.byteLength, sha256, maxBytes };
}

/**
 * Retain, hand the entry to the sink WITHOUT awaiting it, and answer what goes on `SendResult.mime`.
 * Fire-and-forget, as `@ultimat3/mcp`'s audit hook is: the provider already accepted the message,
 * and a sink that never settles would hold the job unsettled until its lease was reclaimed and the
 * mail sent again. A throw, synchronous or rejected, is logged and never reaches the send.
 */
export function keepMime(
  options: RetainMimeOptions,
  raw: string,
  entry: Omit<RetainedMimeEntry, 'mime'>,
): RetainedMime {
  const mime = retainedMime(raw, options.maxBytes ?? DEFAULT_RETAIN_MIME_MAX_BYTES);
  const sink = options.onRetained;
  if (sink !== undefined) {
    Promise.resolve()
      .then(() => sink({ ...entry, mime }))
      .catch((error: unknown) => {
        logger.warn('mail.retain_mime.failed', {
          mailId: entry.mailId,
          driver: entry.driver,
          id: entry.id,
          reason: renderThrowable(error),
        });
      });
  }
  return mime;
}

/** `result` with `mime` attached when retention is on; the same object when it is off. */
export function withRetainedMime(
  options: RetainMimeOptions | undefined,
  result: SendResult,
  mailId: string,
  raw: string,
): SendResult {
  if (options === undefined) return result;
  const mime = keepMime(options, raw, {
    mailId,
    id: result.id,
    driver: result.driver,
    idempotencyKey: result.idempotencyKey,
  });
  return { ...result, mime };
}
