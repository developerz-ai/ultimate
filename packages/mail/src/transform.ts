// Single responsibility: the app-level OUTBOUND hook — `setMailTransform(fn)` — run once per
// `send()`, after render and before the idempotency key is minted, so the key, the queue row and
// every retry all carry the transformed bytes. An app adds an open pixel or rewrites its own links
// here; the framework only guarantees WHEN it runs, what it sees, and that a failure never ships.

import type { MailMessage } from './driver';
import { transformFailed } from './errors';
import { assertHeaderSafe } from './header-safety';
import { mailIdempotencyKey } from './idempotency';

/** The parts a transform may rewrite. Never the recipients, the sender or the headers. */
export interface MailRendered {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailTransformMeta {
  /** The mail's `defineMail({ id })` — an app allowlists on it (auth mail is never tracked). */
  readonly mailName: string;
  readonly to: readonly string[];
  /**
   * The key of the UNtransformed message — the caller's `idempotencyKey` when it gave one, the
   * content digest otherwise. Stable across a re-called `send()` of the same mail, so an app keys
   * its tracking row on it and returns the SAME pixel id: the transformed bytes, and therefore the
   * final key the queue and the provider dedupe on, then match too.
   */
  readonly idempotencyKey: string;
  readonly locale: string;
}

/**
 * Deterministic for a given `meta.idempotencyKey`, or a re-called `send()` is a second mail. May be
 * async (an app records its tracking row). A throw fails the send with `X_MAIL_TRANSFORM_FAILED`.
 */
export type MailTransform = (
  rendered: MailRendered,
  meta: MailTransformMeta,
) => MailRendered | Promise<MailRendered>;

let ambient: MailTransform | undefined;

/** Install the app's transform; `undefined` removes it. One per process, like `setMailDriver`. */
export function setMailTransform(transform: MailTransform | undefined): void {
  ambient = transform;
}

export function mailTransform(): MailTransform | undefined {
  return ambient;
}

/**
 * The message `send()` keys and delivers. With no transform installed this returns the SAME
 * object — every app that never calls `setMailTransform` is byte-identical to before.
 */
export async function applyMailTransform(message: MailMessage): Promise<MailMessage> {
  const transform = ambient;
  if (transform === undefined) return message;
  const meta: MailTransformMeta = Object.freeze({
    mailName: message.mailId,
    to: Object.freeze([...message.to]),
    idempotencyKey: mailIdempotencyKey(message),
    locale: message.locale,
  });
  const rendered: MailRendered = Object.freeze({
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  // Reading the result is inside the same guard as the call: a returned object whose `subject`
  // getter throws is a failed transform too, never a raw error escaping `send()`.
  let next: MailRendered | undefined;
  try {
    next = asRendered(await transform(rendered, meta));
  } catch (error) {
    throw transformFailed(message.mailId, `it threw (${describe(error)})`);
  }
  if (next === undefined) {
    throw transformFailed(message.mailId, 'it returned no { subject, html, text } strings');
  }
  if (next.text.trim() === '') {
    throw transformFailed(message.mailId, 'it returned an empty text part');
  }
  const transformed: MailMessage = { ...message, ...next };
  // The subject is the transform's to change, so the header rule is re-checked on what it returned.
  assertHeaderSafe(transformed);
  return transformed;
}

function asRendered(value: unknown): MailRendered | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { subject, html, text } = value as Record<string, unknown>;
  if (typeof subject !== 'string' || typeof html !== 'string' || typeof text !== 'string') {
    return undefined;
  }
  return { subject, html, text };
}

/**
 * What KIND of value was thrown, from a closed list — never its message and never its `name`,
 * which are the app's strings and may carry a recipient address.
 */
const KNOWN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);

function describe(error: unknown): string {
  if (error instanceof Error) return KNOWN_ERRORS.has(error.name) ? error.name : 'an Error';
  return typeof error;
}
