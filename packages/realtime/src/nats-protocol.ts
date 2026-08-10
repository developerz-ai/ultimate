// Single responsibility: the NATS client protocol codec — pure encode/decode of the text
// protocol nats-server speaks on port 4222. No sockets, no timers, no randomness: chunks of
// bytes in, whole operations out, so the socket layer can be tested with no network at all.

import { TransportProtocolError } from './errors';

const decoder = new TextDecoder();
const CR = 0x0d;
const LF = 0x0a;

/** A single declared payload is bounded so a corrupt byte count cannot allocate the machine. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const protocolError = (stage: 'read' | 'headers', detail: string): TransportProtocolError =>
  new TransportProtocolError({ transport: 'nats', stage, detail });
const missingArg = (label: string): never => {
  throw protocolError('read', `missing ${label}`);
};

export interface NatsServerInfo {
  readonly serverId: string;
  readonly version: string;
  readonly maxPayload: number;
  readonly tlsRequired: boolean;
  readonly tlsAvailable: boolean;
  readonly authRequired: boolean;
  readonly headers: boolean;
  readonly nonce: string | undefined;
}
export type NatsHeaders = ReadonlyMap<string, string>;
export interface NatsMessage {
  readonly subject: string;
  readonly sid: string;
  readonly replyTo: string | undefined;
  readonly payload: Uint8Array;
  readonly headers: NatsHeaders;
  /** From `NATS/1.0 <code> <description>`; `undefined` on a plain MSG or a status-less header. */
  readonly status: number | undefined;
  readonly description: string | undefined;
}
export type NatsOperation =
  | { readonly kind: 'info'; readonly info: NatsServerInfo }
  | { readonly kind: 'msg'; readonly message: NatsMessage }
  | { readonly kind: 'ping' }
  | { readonly kind: 'pong' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'err'; readonly detail: string };

const EMPTY_HEADERS: NatsHeaders = new Map<string, string>();
const indexOfCrlf = (bytes: Uint8Array, from: number): number => {
  for (let i = from; i < bytes.length - 1; i += 1) {
    if (bytes[i] === CR && bytes[i + 1] === LF) return i;
  }
  return -1;
};
export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};
const splitArgs = (text: string): string[] =>
  text.split(/[ \t]+/).filter((part) => part.length > 0);
const parseByteCount = (text: string | undefined): number => {
  if (text === undefined || !/^\d+$/.test(text)) {
    throw protocolError('read', `expected a byte count, got "${text ?? ''}"`);
  }
  return Number(text);
};

const parseInfo = (json: string): NatsServerInfo => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw protocolError('read', `INFO json did not parse: "${json}"`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw protocolError('read', `INFO json was not an object: "${json}"`);
  }
  const info = parsed as Record<string, unknown>;
  return {
    serverId: typeof info['server_id'] === 'string' ? info['server_id'] : '',
    version: typeof info['version'] === 'string' ? info['version'] : '',
    maxPayload: typeof info['max_payload'] === 'number' ? info['max_payload'] : 1_048_576,
    tlsRequired: info['tls_required'] === true,
    tlsAvailable: info['tls_available'] === true,
    authRequired: info['auth_required'] === true,
    headers: info['headers'] === true,
    nonce: typeof info['nonce'] === 'string' ? info['nonce'] : undefined,
  };
};

/** Parses an HMSG/HPUB header block: `NATS/1.0[ <code> <description>]\r\nKey: Value\r\n...\r\n\r\n`. */
export function parseHeaders(bytes: Uint8Array): {
  readonly headers: ReadonlyMap<string, string>;
  readonly status: number | undefined;
  readonly description: string | undefined;
} {
  const lines = decoder.decode(bytes).split('\r\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('NATS/1.0')) {
    throw protocolError('headers', `header block did not start with NATS/1.0: "${first}"`);
  }
  const statusPart = first.slice('NATS/1.0'.length).trim();
  let status: number | undefined;
  let description: string | undefined;
  if (statusPart.length > 0) {
    const spaceAt = statusPart.search(/\s/);
    const code = spaceAt < 0 ? statusPart : statusPart.slice(0, spaceAt);
    if (!/^\d{3}$/.test(code)) {
      throw protocolError('headers', `status code was not 3 digits: "${code}"`);
    }
    status = Number(code);
    description = spaceAt < 0 ? '' : statusPart.slice(spaceAt + 1).trim();
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const colonAt = line.indexOf(':');
    if (colonAt < 0) continue;
    headers.set(line.slice(0, colonAt).trim().toLowerCase(), line.slice(colonAt + 1).trim());
  }
  return { headers, status, description };
}

/** Chunks in, whole operations out. A TCP read boundary lands anywhere. */
export class NatsProtocolParser {
  #buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : concatBytes(this.#buffer, chunk);
  }

  /** Bytes read but not yet consumed — what a partial frame is holding. */
  get buffered(): number {
    return this.#buffer.length;
  }

  /** The next complete operation, or `undefined` when more bytes are needed. */
  next(): NatsOperation | undefined {
    const buffer = this.#buffer;
    const lineEnd = indexOfCrlf(buffer, 0);
    if (lineEnd < 0) return undefined;
    const line = decoder.decode(buffer.subarray(0, lineEnd));
    const spaceAt = line.search(/[ \t]/);
    const verb = (spaceAt < 0 ? line : line.slice(0, spaceAt)).toUpperCase();
    const rest = spaceAt < 0 ? '' : line.slice(spaceAt + 1).trim();
    if (verb === 'MSG' || verb === 'HMSG') {
      return this.#takeMessage(lineEnd, rest, verb === 'HMSG');
    }
    this.#buffer = buffer.subarray(lineEnd + 2);
    switch (verb) {
      case 'INFO':
        return { kind: 'info', info: parseInfo(rest) };
      case 'PING':
        return { kind: 'ping' };
      case 'PONG':
        return { kind: 'pong' };
      case '+OK':
        return { kind: 'ok' };
      case '-ERR': {
        const trimmed = rest.trim();
        const quoted = trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'");
        return { kind: 'err', detail: quoted ? trimmed.slice(1, -1) : trimmed };
      }
      default:
        throw protocolError('read', `unknown verb "${verb}"`);
    }
  }

  #takeMessage(lineEnd: number, rest: string, headered: boolean): NatsOperation | undefined {
    const buffer = this.#buffer;
    const args = splitArgs(rest);
    const minArgs = headered ? 4 : 3;
    const maxArgs = headered ? 5 : 4;
    if (args.length !== minArgs && args.length !== maxArgs) {
      const verb = headered ? 'HMSG' : 'MSG';
      throw protocolError('read', `${verb} wants ${minArgs} or ${maxArgs} args, got "${rest}"`);
    }
    const hasReply = args.length === maxArgs;
    const subject = args[0] ?? missingArg('subject');
    const sid = args[1] ?? missingArg('sid');
    const replyTo = hasReply ? (args[2] ?? missingArg('reply-to')) : undefined;
    const headerBytes = headered ? parseByteCount(args[hasReply ? 3 : 2]) : 0;
    const totalBytes = parseByteCount(args[args.length - 1]);
    if (headered && totalBytes < headerBytes) {
      throw protocolError('read', `HMSG total ${totalBytes} is smaller than header ${headerBytes}`);
    }
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      throw protocolError('read', `payload of ${totalBytes} bytes exceeds ${MAX_PAYLOAD_BYTES}`);
    }
    const payloadStart = lineEnd + 2;
    const headerEnd = payloadStart + headerBytes;
    const payloadEnd = payloadStart + totalBytes;
    const end = payloadEnd + 2;
    if (buffer.length < end) return undefined;
    if (buffer[payloadEnd] !== CR || buffer[payloadEnd + 1] !== LF) {
      throw protocolError('read', `payload was not followed by CRLF at offset ${payloadEnd}`);
    }
    const { headers, status, description } = headered
      ? parseHeaders(buffer.subarray(payloadStart, headerEnd))
      : { headers: EMPTY_HEADERS, status: undefined, description: undefined };
    this.#buffer = buffer.subarray(end);
    return {
      kind: 'msg',
      message: {
        subject,
        sid,
        replyTo,
        payload: buffer.subarray(headerEnd, payloadEnd),
        headers,
        status,
        description,
      },
    };
  }
}
