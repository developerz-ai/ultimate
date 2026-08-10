// Single responsibility: the client half of the NATS protocol — the commands a client writes.
// Split from the parser on purpose: encoding is pure string building with no state at all, while
// decoding has to carry a buffer across chunk boundaries, and mixing the two hides both.

import { TransportProtocolError } from './errors';
import { concatBytes, type NatsHeaders } from './nats-protocol';

const encoder = new TextEncoder();
const CRLF = '\r\n';

export interface NatsConnectOptions {
  readonly verbose?: boolean; // default false
  readonly pedantic?: boolean; // default false
  readonly name?: string; // client name, default 'ultimate'
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly authToken?: string | undefined;
  readonly tlsRequired?: boolean; // default false
}
const CLIENT_VERSION = '0.0.1';

/** `CONNECT {json}\r\n` — the first frame a client sends, before subscribing or publishing. */
export function connectMessage(options: NatsConnectOptions = {}): Uint8Array {
  const payload: Record<string, unknown> = {
    verbose: options.verbose ?? false,
    pedantic: options.pedantic ?? false,
    tls_required: options.tlsRequired ?? false,
    name: options.name ?? 'ultimate',
    lang: 'bun',
    version: CLIENT_VERSION,
    protocol: 1,
    headers: true,
    no_responders: true,
  };
  if (options.user !== undefined && options.pass !== undefined) {
    payload['user'] = options.user;
    payload['pass'] = options.pass;
  }
  if (options.authToken !== undefined) payload['auth_token'] = options.authToken;
  return encoder.encode(`CONNECT ${JSON.stringify(payload)}${CRLF}`);
}

/**
 * A header line ends at the first CRLF, so a break inside a key or value closes the line early and
 * everything after it is read as a fresh command. A security boundary, not a style rule.
 */
const HEADER_BREAK = /[\r\n]/;

const encodeHeaderBlock = (headers: NatsHeaders): Uint8Array => {
  let block = `NATS/1.0${CRLF}`;
  for (const [key, value] of headers) {
    if (HEADER_BREAK.test(key) || HEADER_BREAK.test(value)) {
      throw new TransportProtocolError({
        transport: 'nats',
        stage: 'headers',
        // Quoted through JSON so the break that caused this cannot break the message reporting it.
        detail: `header ${JSON.stringify(key)} carries a CR or LF, which would inject a command`,
        fix: "strip the breaks first: headers.set(name, value.replace(/[\\r\\n]+/g, ' '))",
      });
    }
    block += `${key}: ${value}${CRLF}`;
  }
  return encoder.encode(`${block}${CRLF}`);
};

/** `PUB` when there are no headers, `HPUB` when there are — never both shapes for one call. */
export function pubMessage(args: {
  readonly subject: string;
  readonly payload?: Uint8Array | undefined;
  readonly replyTo?: string | undefined;
  readonly headers?: NatsHeaders | undefined;
}): Uint8Array {
  const payload = args.payload ?? new Uint8Array(0);
  const replyPart = args.replyTo !== undefined ? ` ${args.replyTo}` : '';
  const crlfBytes = encoder.encode(CRLF);
  if (args.headers === undefined || args.headers.size === 0) {
    const control = `PUB ${args.subject}${replyPart} ${payload.length}${CRLF}`;
    return concatBytes(encoder.encode(control), payload, crlfBytes);
  }
  const headerBlock = encodeHeaderBlock(args.headers);
  const total = headerBlock.length + payload.length;
  const control = `HPUB ${args.subject}${replyPart} ${headerBlock.length} ${total}${CRLF}`;
  return concatBytes(encoder.encode(control), headerBlock, payload, crlfBytes);
}

export function subMessage(subject: string, sid: string, queue?: string): Uint8Array {
  const queuePart = queue !== undefined ? ` ${queue}` : '';
  return encoder.encode(`SUB ${subject}${queuePart} ${sid}${CRLF}`);
}

export function unsubMessage(sid: string, max?: number): Uint8Array {
  const maxPart = max !== undefined ? ` ${max}` : '';
  return encoder.encode(`UNSUB ${sid}${maxPart}${CRLF}`);
}

export const PING_MESSAGE: Uint8Array = encoder.encode(`PING${CRLF}`);
export const PONG_MESSAGE: Uint8Array = encoder.encode(`PONG${CRLF}`);
