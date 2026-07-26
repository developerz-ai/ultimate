// Single responsibility: TOTP (RFC 6238) and recovery codes. The drift window is explicit and
// small, and every accepted step is remembered: without replay rejection a code shouted over a
// phishing page stays valid for the rest of its 30 seconds. Recovery codes are hashed at rest
// and single-use, so a database dump is not a permanent MFA bypass.

import { randomBytes, sha256Hex, timingSafeEqual } from './tokens';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step. Two steps is a minute of validity; that is a window, not a clock tolerance. */
export const TOTP_DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] as string;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31] as string;
  return out;
}

/**
 * Tolerant by design: padding, spaces and the dashes authenticator apps display are skipped,
 * and any other character fails the decode closed (empty output -> no code ever matches).
 */
export function base32Decode(value: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const char of value.toUpperCase()) {
    if (char === '=' || char === ' ' || char === '-') continue;
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return new Uint8Array(0);
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/** 160 bits — the HMAC-SHA1 block size every authenticator app agrees on. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpEnrolment {
  readonly secret: string;
  readonly uri: string;
  readonly digits: number;
  readonly periodSeconds: number;
}

export interface EnrolTotpInput {
  readonly issuer: string;
  readonly account: string;
  readonly secret?: string | undefined;
}

export function enrolTotp(input: EnrolTotpInput): TotpEnrolment {
  const secret = input.secret ?? generateTotpSecret();
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return {
    secret,
    uri: `otpauth://totp/${label}?${query.toString()}`,
    digits: TOTP_DIGITS,
    periodSeconds: TOTP_STEP_SECONDS,
  };
}

export function totpStep(at: Date, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

function counterBytes(step: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = step;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

/** HMAC-SHA1 + RFC 4226 dynamic truncation. SHA1 here is a spec requirement, not a choice. */
export function totpCode(secret: string, step: number, digits: number = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const mac = Uint8Array.from(
    new Bun.CryptoHasher('sha1', key).update(counterBytes(step)).digest(),
  );
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  readonly ok: boolean;
  /** The step the code belonged to — feed it to `TotpReplayGuard.remember()`. */
  readonly step: number | null;
}

export interface VerifyTotpInput {
  readonly secret: string;
  readonly code: string;
  readonly at: Date;
  readonly drift?: number | undefined;
  /** Steps already spent by this subject. A match inside the set is a replay, not a login. */
  readonly usedSteps?: ReadonlySet<number> | undefined;
}

export function verifyTotp(input: VerifyTotpInput): TotpVerification {
  const drift = input.drift ?? TOTP_DRIFT_STEPS;
  const current = totpStep(input.at);
  const candidate = input.code.replaceAll(' ', '');
  for (let offset = -drift; offset <= drift; offset += 1) {
    const step = current + offset;
    if (!timingSafeEqual(totpCode(input.secret, step), candidate)) continue;
    if (input.usedSteps?.has(step) === true) return { ok: false, step };
    return { ok: true, step };
  }
  return { ok: false, step: null };
}

export interface TotpReplayGuard {
  isUsed(subject: string, step: number): boolean;
  remember(subject: string, step: number, at: Date): void;
}

/**
 * In-memory by default because a single web process is the common case; a multi-process
 * deployment passes a Redis-backed guard with the same two methods. Steps older than the
 * drift window are dropped — nothing outside it can be replayed anyway.
 */
export function createTotpReplayGuard(drift: number = TOTP_DRIFT_STEPS): TotpReplayGuard {
  const used = new Map<string, Set<number>>();
  return {
    isUsed: (subject, step) => used.get(subject)?.has(step) === true,
    remember: (subject, step, at) => {
      const steps = used.get(subject) ?? new Set<number>();
      const floor = totpStep(at) - drift;
      for (const known of steps) {
        if (known < floor) steps.delete(known);
      }
      steps.add(step);
      used.set(subject, steps);
    },
  };
}

export interface RecoveryCodeSet {
  /** Shown once, at enrolment. Never persisted, never re-derivable. */
  readonly codes: readonly string[];
  readonly hashes: readonly string[];
}

const normaliseRecoveryCode = (code: string): string =>
  code.replaceAll('-', '').replaceAll(' ', '').toUpperCase();

export function generateRecoveryCodes(count = 10): RecoveryCodeSet {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`);
  }
  return { codes, hashes: codes.map((code) => sha256Hex(normaliseRecoveryCode(code))) };
}

/**
 * Returns the remaining hashes with the redeemed one removed, or `null` if nothing matched.
 * The caller persists the result — that write is what makes a code single-use.
 */
export function redeemRecoveryCode(
  code: string,
  hashes: readonly string[],
): readonly string[] | null {
  const candidate = sha256Hex(normaliseRecoveryCode(code));
  let matched = false;
  const remaining: string[] = [];
  for (const hash of hashes) {
    if (!matched && timingSafeEqual(hash, candidate)) {
      matched = true;
      continue;
    }
    remaining.push(hash);
  }
  return matched ? remaining : null;
}
