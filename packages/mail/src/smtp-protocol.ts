// Single responsibility: pure SMTP protocol parsing and encoding — reply framing, EHLO
// capability parsing, AUTH payloads, DATA-phase dot-stuffing. No sockets, no IO: `smtp-client.ts`
// drives the connection and calls into these functions with raw chunks, getting typed values back.

import { base64Utf8 } from './base64';
import { sendFailed } from './errors';

/** One complete server reply. `text` is every continuation line joined by a space. */
export interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
  readonly text: string;
}

export interface SmtpCapabilities {
  readonly starttls: boolean;
  /** Upper-cased, in the order the server advertised them: e.g. `['PLAIN','LOGIN']`. */
  readonly authMechanisms: readonly string[];
  /** From `SIZE 35882577`. Absent when the server does not advertise one. */
  readonly maxSizeBytes?: number | undefined;
  readonly eightBitMime: boolean;
  readonly pipelining: boolean;
}

export interface ReplyParser {
  /** Feed a socket chunk; returns every reply that completed inside it, in order. */
  push(chunk: string): readonly SmtpReply[];
  /** True when a partial line is still buffered — a connection closing here died mid-reply. */
  hasPending(): boolean;
}

// Three digits then `-` (more lines follow), ` ` (last line) or end-of-line (a bare code with
// no text, also a last line). Anything else — four digits, no digits, prose — is not a reply
// line and must be skipped, never crashed on or folded into a neighbouring reply.
const REPLY_LINE = /^(\d{3})(?:([- ])(.*))?$/;

// RFC 5321 caps a reply line at 512 octets and a full reply is a handful of them, so nothing
// legitimate comes near this. The cap exists because the read deadline in `smtp-client.ts`
// measures the gap between chunks: a peer that dribbles bytes with no line ending resets that
// deadline on every read while this buffer grows, which is an unbounded allocation no timeout
// ever interrupts. Coded failure > OOM.
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * Buffers socket chunks into complete `SmtpReply` values. A chunk can split anywhere — mid-line,
 * mid-CRLF, or carry several replies at once — so the dangling partial line and any continuation
 * lines already read for a reply whose final line has not arrived yet both live in the closure
 * and survive across `push()` calls.
 */
export function createReplyParser(): ReplyParser {
  let buffer = '';
  let pendingLines: string[] | null = null;
  // Continuation lines held for a reply whose final line never arrives are the same unbounded
  // growth as an endless partial line, so both count against the one cap.
  let pendingBytes = 0;

  const guard = (): void => {
    if (buffer.length + pendingBytes <= MAX_REPLY_BYTES) return;
    throw sendFailed({
      driver: 'smtp',
      stage: 'reply',
      detail: `the server sent more than ${MAX_REPLY_BYTES} bytes without completing one reply`,
      retryable: true,
      fix: 'point SMTP_URL at the SMTP port itself — a proxy or an HTTP port answers like this',
    });
  };

  return {
    push(chunk: string): readonly SmtpReply[] {
      buffer += chunk;
      const rawLines = buffer.split('\n');
      buffer = rawLines.pop() ?? '';

      const replies: SmtpReply[] = [];
      for (const rawLine of rawLines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) continue; // blank line: not part of any reply

        const match = REPLY_LINE.exec(line);
        if (!match) continue; // garbage: skipped, not merged into the surrounding reply

        const codeText = match[1];
        if (codeText === undefined) continue; // the group is mandatory; narrows the type for TS

        pendingLines ??= [];
        pendingLines.push(match[3] ?? '');
        pendingBytes += line.length;

        if (match[2] !== '-') {
          replies.push({
            code: Number(codeText),
            lines: pendingLines,
            text: pendingLines.join(' '),
          });
          pendingLines = null;
          pendingBytes = 0;
        }
      }

      // Checked after the loop so only what is still unresolved counts: every reply this chunk
      // completed has already drained both counters, and a well-behaved server never accumulates.
      guard();
      return replies;
    },
    hasPending(): boolean {
      return buffer.length > 0 || pendingLines !== null;
    },
  };
}

const STARTTLS_LINE = /^STARTTLS$/i;
const PIPELINING_LINE = /^PIPELINING$/i;
const EIGHT_BIT_MIME_LINE = /^8BITMIME$/i;
const SIZE_LINE = /^SIZE(?:\s+(\S+))?$/i;
// Some servers still send the legacy `AUTH=PLAIN LOGIN` form instead of `AUTH PLAIN LOGIN`;
// `[=\s]+` accepts either separator, and mechanisms are re-split on any run of spaces too.
const AUTH_LINE = /^AUTH[=\s]+(.*)$/i;

/** `EHLO` reply -> what the server can do. The greeting line itself is not a capability. */
export function parseCapabilities(reply: SmtpReply): SmtpCapabilities {
  let starttls = false;
  let pipelining = false;
  let eightBitMime = false;
  let maxSizeBytes: number | undefined;
  const authMechanisms: string[] = [];

  for (const raw of reply.lines.slice(1)) {
    const line = raw.trim();
    const sizeMatch = SIZE_LINE.exec(line);
    const authMatch = AUTH_LINE.exec(line);

    if (STARTTLS_LINE.test(line)) {
      starttls = true;
    } else if (PIPELINING_LINE.test(line)) {
      pipelining = true;
    } else if (EIGHT_BIT_MIME_LINE.test(line)) {
      eightBitMime = true;
    } else if (sizeMatch) {
      const value = sizeMatch[1];
      // A non-numeric or missing size is silently absent — never `Number('abc')`'s `NaN`.
      if (value !== undefined && /^\d+$/.test(value)) maxSizeBytes = Number(value);
    } else if (authMatch) {
      for (const mechanism of (authMatch[1] ?? '').split(/\s+/)) {
        if (mechanism.length > 0) authMechanisms.push(mechanism.toUpperCase());
      }
    }
  }

  return { starttls, authMechanisms, maxSizeBytes, eightBitMime, pipelining };
}

/** RFC 4616: base64 of `\0user\0password`. */
export function authPlain(user: string, password: string): string {
  return base64Utf8(`\0${user}\0${password}`);
}

/** True for a 4xx reply: a greylist or throttle that the job's next attempt can clear. */
export function isTransient(code: number): boolean {
  return code >= 400 && code < 500;
}

/** True for 2xx. 3xx is a continuation (`354` for DATA, `334` for AUTH), never a success. */
export function isPositive(code: number): boolean {
  return code >= 200 && code < 300;
}

const LINE_BREAK = /\r\n|\n/;

/**
 * RFC 5321 transparency: CRLF-normalise the message and double any leading `.` so a body line
 * of `.` cannot end the DATA phase early. Does NOT append the `\r\n.\r\n` terminator — the
 * client owns that.
 */
export function dotStuff(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/** One line fit for an error `cause`: `550 5.1.1 no such user`. Never multi-line. */
export function replySummary(reply: SmtpReply): string {
  return reply.text.length === 0 ? `${reply.code}` : `${reply.code} ${reply.text}`;
}
