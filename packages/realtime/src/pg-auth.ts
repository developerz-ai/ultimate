// Single responsibility: Postgres authentication computations — MD5 legacy hashing and the
// SCRAM-SHA-256 SASL exchange (RFC 5802 + RFC 7677). Pure crypto over bytes in, bytes out: the
// socket, the message envelope and the AuthenticationXxx dispatch belong to pg-wire.ts, not here.

import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import type { Rng } from './thundering-herd';

export const SCRAM_SHA_256 = 'SCRAM-SHA-256';

// No channel binding: `n,,` is the gs2-header for "client does not support channel binding".
// `c=biws` in the final message is that same 3-byte header, base64'd — fixed, so it is spelled
// out where used rather than recomputed on every exchange.
const GS2_HEADER = 'n,,';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One SASL exchange. Created per connection; never reused across connections. */
export interface ScramSession {
  readonly mechanism: string;
  /** `n,,n=,r=<nonce>` — the payload of SASLInitialResponse (the wire framing is not yours). */
  clientFirst(): Uint8Array;
  /** server-first-message in, client-final-message out. */
  clientFinal(serverFirst: Uint8Array): Promise<Uint8Array>;
  /** server-final-message. Resolves when the server proved it knows the password; throws otherwise. */
  verify(serverFinal: Uint8Array): Promise<void>;
}

class ScramSha256Session implements ScramSession {
  readonly mechanism = SCRAM_SHA_256;
  readonly #password: string;
  readonly #clientNonce: string;
  readonly #clientFirstBare: string;
  #serverSignature: Uint8Array | undefined;
  #finalized = false;

  constructor(args: { password: string; nonce: string }) {
    this.#password = args.password;
    this.#clientNonce = args.nonce;
    // The username is deliberately empty: Postgres takes it from the startup packet and only
    // wants a SASLprep'd empty `n=` here, per its SCRAM implementation.
    this.#clientFirstBare = `n=,r=${args.nonce}`;
  }

  clientFirst(): Uint8Array {
    return encoder.encode(`${GS2_HEADER}${this.#clientFirstBare}`);
  }

  async clientFinal(serverFirst: Uint8Array): Promise<Uint8Array> {
    if (this.#finalized) {
      throw new ReplicationProtocolError({
        stage: 'auth',
        detail: 'clientFinal() was already called on this SCRAM session; a session is single-use',
        fix: 'call scramSession() again to start a fresh exchange for the next connection attempt',
      });
    }
    this.#finalized = true;

    const serverFirstText = decoder.decode(serverFirst);
    const { nonce: serverNonce, salt, iterations } = parseServerFirst(serverFirstText);
    // The server must echo our nonce back as a prefix of the combined one — the RFC 5802 check
    // that stands between this exchange and a server that never actually saw our client-first.
    if (!serverNonce.startsWith(this.#clientNonce)) {
      throw new ReplicationProtocolError({
        stage: 'auth',
        detail: `server nonce "${serverNonce}" does not extend client nonce "${this.#clientNonce}"`,
        fix: 'x doctor db — the server did not echo the client nonce; check for a proxy on the replication URL',
      });
    }

    const saltedPassword = await pbkdf2(this.#password, salt, iterations);
    const clientKey = await hmac(saltedPassword, 'Client Key');
    const storedKey = await sha256(clientKey);

    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${this.#clientFirstBare},${serverFirstText},${clientFinalWithoutProof}`;

    const clientSignature = await hmac(storedKey, authMessage);
    const clientProof = xorBytes(clientKey, clientSignature);

    const serverKey = await hmac(saltedPassword, 'Server Key');
    this.#serverSignature = await hmac(serverKey, authMessage);

    return encoder.encode(`${clientFinalWithoutProof},p=${bytesToBase64(clientProof)}`);
  }

  async verify(serverFinal: Uint8Array): Promise<void> {
    if (!this.#serverSignature) {
      throw new ReplicationProtocolError({
        stage: 'auth',
        detail: 'verify() was called before clientFinal() produced a server signature to check',
        fix: 'call clientFinal() with the server-first-message before verify()',
      });
    }

    const text = decoder.decode(serverFinal);
    const attrs = parseAttributes(text);

    const serverError = attrs.get('e');
    if (serverError !== undefined) {
      throw new ReplicationFailedError({
        stage: 'auth',
        detail:
          `server rejected the SCRAM exchange: ${serverError} — the password in DATABASE_URL ` +
          "is not this role's, so either that value or the role itself has to change",
        fix: 'psql "$DATABASE_URL" -c "ALTER ROLE <user> WITH PASSWORD \'<new>\'"',
      });
    }

    const proof = attrs.get('v');
    if (proof === undefined) {
      throw new ReplicationProtocolError({
        stage: 'auth',
        detail: `server-final-message has neither "v=" nor "e=": "${text}"`,
      });
    }
    // Every byte, no early return: a mismatch found sooner than a mismatch found later must take
    // the same time, or the comparison itself becomes an oracle for guessing the right proof.
    if (!constantTimeEqual(decodeBase64('server signature', proof), this.#serverSignature)) {
      throw new ReplicationFailedError({
        stage: 'auth',
        detail:
          'server-final-message signature does not match — the server could not prove it knows ' +
          'the password, so DATABASE_URL points at something other than postgres, or the role ' +
          'password changed under this connection',
        fix: 'psql "$DATABASE_URL" -c "SELECT version()"',
      });
    }
  }
}

export function scramSession(args: { password: string; nonce: string }): ScramSession {
  return new ScramSha256Session(args);
}

/**
 * 18 random bytes, base64 — the client nonce. RFC 5802 §5.1 requires a fresh nonce per exchange
 * and points at RFC 4086 for what "random" has to mean there, so the default source is the
 * CSPRNG: a predictable nonce lets an attacker who has recorded one exchange replay a proof
 * against a client whose next nonce it can guess. `Rng` is the deterministic *test* seam and
 * nothing else — production passes no argument.
 */
export function scramNonce(rng?: Rng): string {
  const bytes = new Uint8Array(18);
  if (rng === undefined) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(rng() * 256) & 0xff;
    }
  }
  // Base64's alphabet never includes `,`, so the nonce can never collide with the attribute
  // separator it will be embedded next to on the wire — nothing further to escape.
  return bytesToBase64(bytes);
}

/**
 * `md5` + md5(md5(password + user) + salt) — the AuthenticationMD5Password answer. The inner
 * digest feeds the outer one as its *hex text*, not its raw bytes: that double encoding is
 * Postgres's wire format, not a choice made here. MD5 has no WebCrypto entry, so this is the
 * one spot in the module that reaches for `Bun.CryptoHasher` — the hash algorithm is legacy and
 * the server's own choice, not one this module would otherwise make.
 */
export function md5Password(args: { user: string; password: string; salt: Uint8Array }): string {
  const inner = new Bun.CryptoHasher('md5').update(args.password + args.user).digest('hex');
  const outer = new Bun.CryptoHasher('md5').update(inner).update(args.salt).digest('hex');
  return `md5${outer}`;
}

/** Picks SCRAM-SHA-256 out of the mechanism list the server offered, or throws. */
export function chooseMechanism(offered: readonly string[]): string {
  if (offered.includes(SCRAM_SHA_256)) return SCRAM_SHA_256;
  throw new ReplicationProtocolError({
    stage: 'auth',
    detail:
      offered.length === 0
        ? 'the server offered no SASL mechanisms'
        : `the server only offered ${offered.join(', ')} — channel binding ("-PLUS") is not supported here`,
    fix: 'set password_encryption = scram-sha-256 on the server and recreate the role password',
  });
}

/**
 * The iteration count is the server's to choose, and `pbkdf2()` runs it before this client has
 * proved anything about the peer — so an unbounded `i=` is a peer spending our CPU at will, on
 * the connect path, where nothing above imposes a deadline. RFC 7677 §4 sets the floor at 4096
 * and a real postgres sends exactly that, so two orders of magnitude of headroom refuses the
 * attack without ever refusing a server.
 */
const MAX_SCRAM_ITERATIONS = 1_000_000;

interface ServerFirst {
  readonly nonce: string;
  readonly salt: Uint8Array;
  readonly iterations: number;
}

function parseServerFirst(text: string): ServerFirst {
  const attrs = parseAttributes(text);
  const nonce = attrs.get('r');
  const saltB64 = attrs.get('s');
  const iterationsText = attrs.get('i');
  if (nonce === undefined || saltB64 === undefined || iterationsText === undefined) {
    throw new ReplicationProtocolError({
      stage: 'auth',
      detail: `server-first-message is missing r=, s= or i=: "${text}"`,
    });
  }
  if (!/^[1-9]\d*$/.test(iterationsText)) {
    throw new ReplicationProtocolError({
      stage: 'auth',
      detail: `server-first-message iteration count "${iterationsText}" is not a positive integer`,
    });
  }
  const iterations = Number.parseInt(iterationsText, 10);
  if (iterations > MAX_SCRAM_ITERATIONS) {
    throw new ReplicationProtocolError({
      stage: 'auth',
      detail: `server-first-message asked for ${iterationsText} PBKDF2 iterations, above the ${MAX_SCRAM_ITERATIONS} ceiling`,
      fix: 'x doctor db — point the replication URL at postgres itself; a real server asks for 4096',
    });
  }
  const salt = decodeBase64('salt', saltB64);
  return { nonce, salt, iterations };
}

/** `k=v` pairs split on `,`. Unrecognised keys are ignored — RFC 5802 reserves them for extensions. */
function parseAttributes(message: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const segment of message.split(',')) {
    const at = segment.indexOf('=');
    if (at < 0) continue;
    attrs.set(segment.slice(0, at), segment.slice(at + 1));
  }
  return attrs;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    // Copied into a fresh buffer: WebCrypto's `BufferSource` excludes a SharedArrayBuffer-backed
    // view, and these values arrive as subarrays of the read buffer.
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(mac);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let index = 0; index < a.length; index += 1) out[index] = (a[index] ?? 0) ^ (b[index] ?? 0);
  return out;
}

/** Every byte, no early return — a timing side-channel on the server proof is a MITM's foothold. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A server that sends a non-base64 attribute is a wire-format bug, not an auth failure. */
function decodeBase64(label: string, value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new ReplicationProtocolError({
      stage: 'auth',
      detail: `${label} "${value}" is not valid base64`,
    });
  }
}
