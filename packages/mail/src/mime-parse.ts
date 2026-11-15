// Single responsibility: raw RFC 5322 bytes → the message's top-level headers, its text and HTML
// bodies and its attachments as bytes. Bounded before it allocates: total bytes, parts, nesting
// depth, attachments and each header section. Every refusal is coded (`mime-parse-errors.ts`).
// In-tree, no dependency: the bar in docs/idea/18-build-vs-wrap.md is not met by a walk this size.

import { binaryOf, decodeCharset, decodeTransfer } from './mime-parse-decode';
import { inboundMalformed, inboundTooLarge } from './mime-parse-errors';
import {
  type HeaderField,
  headerOf,
  parseHeaderSection,
  parseStructured,
} from './mime-parse-headers';

export interface MimeLimits {
  /** The whole message. */
  readonly maxBytes: number;
  /** Every node of the tree, multipart containers included. */
  readonly maxParts: number;
  /** Multipart nesting below the top level. */
  readonly maxDepth: number;
  readonly maxAttachments: number;
  /** One header section, in bytes. */
  readonly maxHeaderBytes: number;
}

export const DEFAULT_MIME_LIMITS: MimeLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxParts: 100,
  maxDepth: 8,
  maxAttachments: 20,
  maxHeaderBytes: 64 * 1024,
});

export interface MimeAttachment {
  readonly filename: string | undefined;
  /** As declared, lower-cased, parameters dropped; `application/octet-stream` when absent. */
  readonly contentType: string;
  readonly contentId: string | undefined;
  readonly inline: boolean;
  readonly bytes: Uint8Array;
}

export interface ParsedMime {
  readonly headers: readonly HeaderField[];
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly MimeAttachment[];
}

interface Walk {
  readonly limits: MimeLimits;
  parts: number;
  text: string | undefined;
  html: string | undefined;
  readonly attachments: MimeAttachment[];
}

/** Head and body of one entity (binary string). No blank line: all head, empty body. */
function split(entity: string): { readonly head: string; readonly body: string } {
  // A part may open with the blank line itself: no headers, all body (RFC 2046 §5.1.1).
  const match = /^\r?\n|\r?\n\r?\n/.exec(entity);
  if (match === null) return { head: entity, body: '' };
  return { head: entity.slice(0, match.index), body: entity.slice(match.index + match[0].length) };
}

const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body parts between `--boundary` lines; preamble and epilogue dropped (RFC 2046 §5.1.1). */
function bodyParts(body: string, boundary: string): string[] {
  if (!BOUNDARY.test(boundary)) throw inboundMalformed('boundary-invalid');
  // The CRLF before a delimiter belongs to the delimiter, so it is not part of the body before it.
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[\\t ]*(?=\\r?\\n|$)`,
    'g',
  );
  const parts: string[] = [];
  let start: number | undefined;
  let closed = false;
  for (const match of body.matchAll(delimiter)) {
    if (start !== undefined) parts.push(body.slice(start, match.index).replace(/^\r?\n/, ''));
    if (match[1] === '--') {
      closed = true;
      break;
    }
    start = match.index + match[0].length;
  }
  if (start === undefined) throw inboundMalformed('boundary-absent');
  if (!closed) throw inboundMalformed('boundary-unclosed');
  return parts;
}

function leaf(walk: Walk, headers: readonly HeaderField[], body: string, type: string): void {
  const contentType = parseStructured(headerOf(headers, 'content-type'));
  const disposition = parseStructured(headerOf(headers, 'content-disposition'));
  const bytes = decodeTransfer(body, headerOf(headers, 'content-transfer-encoding'));
  const filename = disposition.params.get('filename') ?? contentType.params.get('name');
  const isBody =
    disposition.value !== 'attachment' &&
    filename === undefined &&
    (type === 'text/plain' || type === 'text/html');
  if (isBody) {
    const text = decodeCharset(bytes, contentType.params.get('charset'));
    // Split bodies (a client's text, image, text) are read as one, in order.
    if (type === 'text/plain') walk.text = (walk.text ?? '') + text;
    else walk.html = (walk.html ?? '') + text;
    return;
  }
  if (walk.attachments.length >= walk.limits.maxAttachments) {
    throw inboundTooLarge('maxAttachments', walk.limits.maxAttachments);
  }
  const contentId = headerOf(headers, 'content-id')?.replace(/^<|>$/g, '');
  walk.attachments.push({
    filename,
    contentType: type,
    contentId: contentId === '' ? undefined : contentId,
    inline: disposition.value === 'inline',
    bytes,
  });
}

function entity(walk: Walk, raw: string, depth: number): readonly HeaderField[] {
  walk.parts += 1;
  if (walk.parts > walk.limits.maxParts) throw inboundTooLarge('maxParts', walk.limits.maxParts);
  const { head, body } = split(raw);
  const headers = parseHeaderSection(head, walk.limits.maxHeaderBytes);
  const contentType = parseStructured(headerOf(headers, 'content-type'));
  // RFC 2045 §5.2: no Content-Type is text/plain; a value with no slash is no type at all.
  const type = contentType.value.includes('/') ? contentType.value : 'text/plain';
  if (!type.startsWith('multipart/')) {
    leaf(walk, headers, body, contentType.value === '' ? 'text/plain' : type);
    return headers;
  }
  if (depth >= walk.limits.maxDepth) throw inboundTooLarge('maxDepth', walk.limits.maxDepth);
  const boundary = contentType.params.get('boundary');
  if (boundary === undefined || boundary === '') throw inboundMalformed('boundary-missing');
  for (const part of bodyParts(body, boundary)) entity(walk, part, depth + 1);
  return headers;
}

/** Parse one message. Throws `X_MAIL_INBOUND_TOO_LARGE` / `X_MAIL_INBOUND_MALFORMED`, coded. */
export function parseMime(bytes: Uint8Array, limits: MimeLimits = DEFAULT_MIME_LIMITS): ParsedMime {
  if (bytes.byteLength > limits.maxBytes) throw inboundTooLarge('maxBytes', limits.maxBytes);
  const raw = binaryOf(bytes);
  // A message opens with a header field: no first line of the form `name:` is not RFC 5322.
  if (!/^[!-9;-~]+[\t ]*:/.test(raw)) throw inboundMalformed('empty');
  const walk: Walk = { limits, parts: 0, text: undefined, html: undefined, attachments: [] };
  const headers = entity(walk, raw, 0);
  return { headers, text: walk.text, html: walk.html, attachments: walk.attachments };
}
