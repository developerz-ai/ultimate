// Single responsibility: a parsed message's attachments → storage, through storage's own upload
// gate (`validateUpload`: size, allowlist, magic-byte sniff) and `put`. Keys are opaque and
// derived from the message id, so a retried job writes the same keys — never a second copy.

import { isUltimateError } from '@ultimat3/core';
import {
  DOCUMENT_CONTENT_TYPES,
  disk as defaultDisk,
  IMAGE_CONTENT_TYPES,
  isStorageError,
  scopedKey,
  type UploadPolicy,
  uploadPolicy,
  validateUpload,
} from '@ultimat3/storage';
import type { InboundAttachment, InboundAttachmentOptions } from './inbound-types';
import type { MimeAttachment } from './mime-parse';

/** What mail carries and nothing executes: images, documents, plain text and CSV. Never HTML/SVG. */
export const INBOUND_ATTACHMENT_TYPES: readonly string[] = Object.freeze([
  ...IMAGE_CONTENT_TYPES,
  ...DOCUMENT_CONTENT_TYPES,
  'text/plain',
  'text/csv',
]);

export const DEFAULT_INBOUND_PREFIX = 'inbound-mail';

let defaultPolicy: UploadPolicy | undefined;
const policyOf = (options: InboundAttachmentOptions): UploadPolicy => {
  if (options.policy !== undefined) return options.policy;
  defaultPolicy ??= uploadPolicy({
    maxBytes: 10 * 1024 * 1024,
    allowedContentTypes: INBOUND_ATTACHMENT_TYPES,
  });
  return defaultPolicy;
};

/** A digest, never the id itself: a provider id may hold characters no storage key takes. */
const folderOf = (eventId: string): string =>
  new Bun.CryptoHasher('sha256').update(eventId).digest('hex').slice(0, 32);

export interface StoreAttachmentsInput {
  readonly attachments: readonly MimeAttachment[];
  readonly options: InboundAttachmentOptions | false;
  readonly eventId: string;
  readonly orgId: string | undefined;
}

export async function storeAttachments(
  input: StoreAttachmentsInput,
): Promise<readonly InboundAttachment[]> {
  const { options } = input;
  const base = (attachment: MimeAttachment) => ({
    filename: attachment.filename,
    declaredType: attachment.contentType,
    size: attachment.bytes.byteLength,
    contentId: attachment.contentId,
    inline: attachment.inline,
  });
  if (options === false) {
    return input.attachments.map((a) => ({ ...base(a), stored: false, refusal: 'disabled' }));
  }
  if (input.attachments.length === 0) return [];
  const target = options.disk?.() ?? defaultDisk();
  const policy = policyOf(options);
  const prefix = options.prefix ?? DEFAULT_INBOUND_PREFIX;
  const folder = folderOf(input.eventId);
  const out: InboundAttachment[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const key =
      input.orgId === undefined
        ? `${prefix}/${folder}/${index}`
        : scopedKey(input.orgId, prefix, folder, String(index));
    let validated: ReturnType<typeof validateUpload>;
    try {
      validated = validateUpload(
        { key, declaredContentType: attachment.contentType, bytes: attachment.bytes },
        policy,
      );
    } catch (error) {
      // The policy's verdict on THIS file: the prefix was screened at `inboundMail()`, so a
      // storage refusal here is about the bytes, the size or the type.
      if (!isStorageError(error) || !isUltimateError(error)) throw error;
      out.push({ ...base(attachment), stored: false, refusal: error.code });
      continue;
    }
    await target.put(validated.key, validated.bytes, {
      contentType: validated.contentType,
      checksum: validated.checksum,
    });
    out.push({
      ...base(attachment),
      stored: true,
      key: validated.key,
      contentType: validated.contentType,
      checksum: validated.checksum,
    });
  }
  return out;
}
