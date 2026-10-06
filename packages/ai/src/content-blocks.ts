// The image and document blocks a user turn may carry: their shapes (the Messages API's own field
// names, so the Anthropic body passes them through untouched), the screen every request runs them
// through before it leaves, and what they add to the pre-flight token estimate.

import { renderCauseValue } from '@ultimat3/core';
import { AiContentUnsupportedError } from './content-errors';
import { AiRequestInvalidError } from './errors';
import type { ContentKind, ModelId } from './models';
import { modelSpec } from './models';
import type { AiContentBlock } from './provider';

/** "JPEG, PNG, GIF, and WebP" — the one list both wire formats publish. */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * Ceilings on a base64 `data` string, in CHARACTERS — the encoded size, which is what the limits
 * are stated in. Image: the Claude API's 10 MB per image (MiB, as its own refusal counts them).
 * Document: 32 MiB, the Messages API's whole-request ceiling, so no single PDF can be legal on
 * its own and still be a request the endpoint refuses. The OpenAI format allows more for a file
 * (50 MB); one table for both, the stricter, so which provider answers never changes the verdict.
 */
export const MAX_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BASE64_CHARS = 32 * 1024 * 1024;

/**
 * An image's pre-flight token estimate: the most visual tokens Claude 4.7+ spends on one image
 * after resizing (4,784 — vision guide, high-resolution tier). Pessimistic on purpose, like the
 * rest of the estimate: the budget reserves it and `record` gives back what the call did not use.
 */
export const IMAGE_TOKEN_ESTIMATE = 4_784;

export type AiImageSource =
  | { readonly type: 'base64'; readonly media_type: ImageMediaType; readonly data: string }
  | { readonly type: 'url'; readonly url: string };

export type AiDocumentSource =
  | { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'text'; readonly media_type: 'text/plain'; readonly data: string };

export interface AiImageBlock {
  readonly type: 'image';
  readonly source: AiImageSource;
}

/** `title` is the Messages API's; on the OpenAI format it becomes the file's `filename`. */
export interface AiDocumentBlock {
  readonly type: 'document';
  readonly source: AiDocumentSource;
  readonly title?: string;
}

export type AiMediaBlock = AiImageBlock | AiDocumentBlock;

/** The two kinds this module screens; a narrowing every consumer of `AiContentBlock` can reuse. */
export function isMediaBlock(block: { readonly type: string }): block is AiMediaBlock {
  return block.type === 'image' || block.type === 'document';
}

/** The fields of a message this screen reads — structural, so `provider.ts` stays the owner. */
interface ScreenedMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type: string }[];
}

/**
 * Refuse every media block the target cannot take, and every one that is malformed, BEFORE the
 * request is built. Blocks reach here from typed code and from replayed JSON alike, so the screen
 * is at runtime: a media type outside the list, a URL that is not `https:`, a base64 string over
 * its ceiling or outside the alphabet. A malformed block is `X_AI_REQUEST_INVALID`; a well-formed
 * one the role or model cannot take is `X_AI_CONTENT_UNSUPPORTED`.
 */
export function assertMediaContent(
  messages: readonly ScreenedMessage[],
  target: { readonly provider: string; readonly model: ModelId },
): void {
  messages.forEach((message, m) => {
    if (typeof message.content === 'string') return;
    message.content.forEach((block, b) => {
      if (!isMediaBlock(block)) return;
      const at = `messages[${m}].content[${b}]`;
      const kind: ContentKind = block.type;
      if (message.role !== 'user') {
        const refusal = { by: 'role', ...target, role: message.role } as const;
        throw new AiContentUnsupportedError({ kind, at, refusal });
      }
      if (!(modelSpec(target.model).input ?? []).includes(kind)) {
        throw new AiContentUnsupportedError({ kind, at, refusal: { by: 'model', ...target } });
      }
      assertSource(block, at);
    });
  });
}

function assertSource(block: AiMediaBlock, at: string): void {
  const fields = fieldsOf(block.source);
  const type = fields['type'];
  // Read as untrusted: a replayed block's title is whatever the JSON held, on either kind.
  const title: unknown = (block as { readonly title?: unknown }).title;
  if (title !== undefined && typeof title !== 'string') {
    throw invalid(
      at,
      `has a title of ${renderCauseValue(title)}`,
      "title: 'q3.pdf'   # a string, or omit the field",
    );
  }
  if (type === 'url') {
    assertUrl(fields['url'], at);
    return;
  }
  if (type === 'base64') {
    assertBase64(block.type, fields, at);
    return;
  }
  if (type === 'text' && block.type === 'document') {
    assertText(fields, at);
    return;
  }
  const legal = block.type === 'image' ? "'base64' or 'url'" : "'base64', 'url' or 'text'";
  throw invalid(
    at,
    `has source.type ${renderCauseValue(type)}`,
    `source: { type: 'base64', media_type, data }   # source.type is ${legal}`,
  );
}

function assertUrl(url: unknown, at: string): void {
  // `https:` only: a `data:` URL is the base64 source spelled a second way, and plain `http:` is a
  // fetch the vendor makes over a channel anyone on the path can rewrite.
  if (typeof url === 'string' && URL.canParse(url) && new URL(url).protocol === 'https:') return;
  throw invalid(
    at,
    `has source.url ${renderCauseValue(url)}, which is not an https: URL`,
    "source: { type: 'url', url: 'https://…' }   # or send the bytes as { type: 'base64', media_type, data }",
  );
}

/** The standard alphabet with its padding, whole: no whitespace, no `data:` prefix, no URL-safe. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function assertBase64(kind: ContentKind, fields: Record<string, unknown>, at: string): void {
  const mediaType = fields['media_type'];
  const legal: readonly unknown[] = kind === 'image' ? IMAGE_MEDIA_TYPES : ['application/pdf'];
  if (!legal.includes(mediaType)) {
    throw invalid(
      at,
      `has media_type ${renderCauseValue(mediaType)}, which a ${kind} block does not take`,
      `media_type: '${String(legal[0])}'   # one of ${legal.join(', ')}${kind === 'document' ? "; text goes as { type: 'text', media_type: 'text/plain', data }" : ''}`,
    );
  }
  const data = fields['data'];
  const cap = kind === 'image' ? MAX_IMAGE_BASE64_CHARS : MAX_DOCUMENT_BASE64_CHARS;
  if (
    typeof data !== 'string' ||
    data.length > cap ||
    data.length % 4 !== 0 ||
    !BASE64.test(data)
  ) {
    const size = typeof data === 'string' ? `${data.length} characters` : renderCauseValue(data);
    throw invalid(
      at,
      `has source.data of ${size}: not one non-empty, padded, standard-alphabet base64 string of at most ${cap} characters`,
      `data: Buffer.from(bytes).toString('base64')   # no data: prefix, at most ${cap} characters; a larger ${kind} goes as an https:// url source`,
    );
  }
}

function assertText(fields: Record<string, unknown>, at: string): void {
  const data = fields['data'];
  if (fields['media_type'] === 'text/plain' && typeof data === 'string' && data !== '') return;
  throw invalid(
    at,
    'has a text source that is not { media_type: "text/plain", data: <non-empty string> }',
    "source: { type: 'text', media_type: 'text/plain', data: text }   # the document's text, non-empty",
  );
}

const invalid = (at: string, what: string, fix: string): AiRequestInvalidError =>
  new AiRequestInvalidError({ detail: `${at} ${what}`, fix });

/**
 * The readable text of one block, for `messageText`. An image and a PDF have none — their cost is
 * `mediaTokenEstimate`'s, never their base64 read as prose — and a text document's is its data.
 */
export function blockText(block: AiContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_result') return block.content;
  if (block.type === 'tool_use') return JSON.stringify(block.input);
  if (block.type !== 'document') return '';
  const source = fieldsOf(block.source);
  return source['type'] === 'text' ? stringOr(source['data']) : '';
}

/**
 * What the media blocks add to the pre-flight estimate. An image is `IMAGE_TOKEN_ESTIMATE`, its
 * worst case. A base64 PDF is its encoded length over four — the same 4-characters-per-token rule
 * as text, and in the published per-page range (text plus one page image) for an ordinary PDF. A
 * text document's `data` is already counted by `messageText`. A PDF by URL is UNKNOWABLE before
 * the vendor fetches it and adds nothing: `record` reconciles to the real usage afterwards.
 *
 * Runs BEFORE the screen (the gateway reserves, then the provider builds), so every field is read
 * as untrusted — a malformed block is estimated as nothing and refused a moment later.
 */
export function mediaTokenEstimate(messages: readonly ScreenedMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (!isMediaBlock(block)) continue;
      if (block.type === 'image') {
        tokens += IMAGE_TOKEN_ESTIMATE;
        continue;
      }
      const source = fieldsOf(block.source);
      if (source['type'] === 'base64') tokens += Math.ceil(stringOr(source['data']).length / 4);
    }
  }
  return tokens;
}

const stringOr = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A block's `source` as untrusted fields: a replayed block may carry none, or `null`. */
function fieldsOf(source: unknown): Readonly<Record<string, unknown>> {
  return typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
}
