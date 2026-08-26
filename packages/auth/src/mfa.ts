// Single responsibility: TOTP (RFC 6238) and recovery codes. The drift window is explicit and
// small, and every accepted step is remembered: without replay rejection a code shouted over a
// phishing page stays valid for the rest of its 30 seconds. Recovery codes are hashed at rest
// and single-use, so a database dump is not a permanent MFA bypass.

import type { Auth } from './auth';
import { mfaSecretInvalid } from './errors';
import { assertFiniteAuthCount } from './policy-numbers';
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
 * Tolerant by design: padding, spaces and the dashes authenticator apps display are skipped, and
 * any other character answers zero bytes.
 *
 * Zero bytes is NOT a decode that failed closed — this comment claimed it was, and it was the
 * whole defect. An HMAC keyed with zero bytes is a perfectly valid HMAC, so `totpCode` derived a
 * six-digit code from no secret at all and every unreadable secret in the table shared that one
 * stream: a code an attacker computes without knowing anything verified against all of them.
 * Zero bytes is therefore refused by both callers that need a key (`totpCode`, `enrolTotp`) and
 * read as a non-verdict by `verifyTotp`. The decoder itself still answers rather than throwing,
 * because "can this be read" is a question `enrolTotp` asks about a value it has not accepted yet.
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
  /**
   * Omitted, the issuer is `auth.mfa.issuer` — one declaration, at `defineAuth`, so the product
   * name an authenticator app shows is not restated at every enrolment. Named here only when one
   * call needs a different one (a separate admin console entry, say).
   */
  readonly issuer?: string | undefined;
  readonly account: string;
  readonly secret?: string | undefined;
}

/**
 * Takes the `Auth` every other entry point in this package takes, and for the same reason: the
 * issuer is configuration, and a pure function that could not read the configuration is what made
 * `defineAuth({ mfa: { issuer } })` a string the framework wrote down and never read.
 */
export function enrolTotp(auth: Auth, input: EnrolTotpInput): TotpEnrolment {
  const secret = input.secret ?? generateTotpSecret();
  // Defence in depth, on the one path that puts a caller's own bytes in front of the table: a
  // secret nothing can ever derive a code from is refused before it is written, not after a user
  // is locked out by it. A minted secret is readable by construction, so only an import gets here.
  if (base32Decode(secret).length === 0) throw mfaSecretInvalid('enrolTotp');
  const issuer = input.issuer ?? auth.mfa.issuer;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
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
  // A zero-length key is not a weak key, it is no key: the hasher below accepts it and answers a
  // code every other unreadable secret answers too. There is no code an unreadable secret is
  // entitled to, so this returns none.
  if (key.length === 0) throw mfaSecretInvalid('totpCode');
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
  // A non-verdict, not a verdict and not a throw. It is the rule `verifyAgainst` (`password.ts`)
  // follows for a stored hash Bun cannot read: a broken stored credential is the generic failure,
  // because a coded throw out of a verify path is a 500 where a refusal belongs and it answers
  // "this account's secret is malformed" to whoever asked. It also keeps `totpCode`'s refusal off
  // the login path entirely — nothing below can reach it with a zero-length key.
  if (base32Decode(input.secret).length === 0) return { ok: false, step: null };
  // A LOOP BOUND, screened before it becomes one: measured, `drift: Infinity` never terminates
  // (`-Infinity + 1` is `-Infinity`) — a synchronous infinite loop on the login path, past every
  // AbortSignal — and `drift: NaN` makes `-NaN <= NaN` false, so the loop never runs and every
  // correct code is rejected as if it were wrong. Zero is legitimate: the current step only.
  const drift = input.drift ?? TOTP_DRIFT_STEPS;
  assertFiniteAuthCount(
    'mfa.drift',
    drift,
    'the verification loop either never terminates (Infinity) or never runs at all (NaN), and the second answers "wrong code" to every correct one',
    0,
  );
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

/** What `createTotpReplayGuard` returns: the interface, plus the bound it keeps, observable. */
export interface MemoryTotpReplayGuard extends TotpReplayGuard {
  readonly size: number;
}

/**
 * Hard bound on tracked subjects. One entry is one user who has completed a TOTP check inside the
 * last drift window, so the natural cardinality is far below this — the cap is the backstop, the
 * same one `DEFAULT_MAX_AUTH_LIMIT_KEYS` is for the limiter's table.
 */
export const DEFAULT_MAX_TOTP_SUBJECTS = 10_000;

/** An idle guard still sweeps this often, so one burst's subjects do not sit until the next. */
const SWEEP_EVERY_STEPS = 2;

/**
 * The cap arithmetic ran on the caller's number unchecked, and the two values a misread config
 * hands you each defeated the bound in their own way: `Infinity` makes `used.size > cap` never
 * true, so the table is exactly as unbounded as before it was capped; `NaN` makes EVERY comparison
 * false, so `used.size <= evictTo` never stops the eviction loop and one sweep empties the table —
 * including the subject who just authenticated, whose step is then replayable. Anything that is
 * not a positive finite integer is a config the caller did not mean, so it takes the default
 * rather than a bound derived from it. A fraction still floors: `2.5` is a caller who meant 2.
 */
function boundedSubjects(maxSubjects: number): number {
  if (!Number.isFinite(maxSubjects) || maxSubjects < 1) return DEFAULT_MAX_TOTP_SUBJECTS;
  return Math.floor(maxSubjects);
}

/** The last step this subject has spent — how close their entry still is to the live window. */
const newestStep = (steps: ReadonlySet<number>): number => {
  let newest = Number.NEGATIVE_INFINITY;
  for (const step of steps) newest = Math.max(newest, step);
  return newest;
};

/**
 * In-memory by default because a single web process is the common case; a multi-process
 * deployment passes a Redis-backed guard with the same two methods. Steps older than the
 * drift window are dropped — nothing outside it can be replayed anyway.
 *
 * Bounded, because the subject map only ever grew: pruning happened inside one subject's `Set`
 * and never revisited a subject who stopped signing in, so the table carried one permanent entry
 * per user for the life of the process. Two rules keep it flat, and the ORDER is the guarantee —
 * evicting a subject makes a step they have already spent replayable again, so it may never be
 * the subject who just authenticated. A subject whose every step has fallen below the drift floor
 * is *forgotten*, not evicted: `verifyTotp` only ever offers a step within ±drift of now, so that
 * entry answers exactly as a missing one and dropping it changes no decision. Only if forgetting
 * is not enough does the cap evict live state, furthest from the live window first — the shape
 * `createAuthLimiter` evicts by, where a live lockout is the last bucket to go.
 */
export function createTotpReplayGuard(
  drift: number = TOTP_DRIFT_STEPS,
  maxSubjects: number = DEFAULT_MAX_TOTP_SUBJECTS,
): MemoryTotpReplayGuard {
  const used = new Map<string, Set<number>>();
  const cap = boundedSubjects(maxSubjects);
  // Batched down to 90% of the cap so the sort below is paid once per 10% of it, not per check.
  const evictTo = Math.max(1, Math.floor(cap * 0.9));
  let lastSweepStep = Number.NEGATIVE_INFINITY;

  const prune = (steps: Set<number>, floor: number): void => {
    for (const known of steps) {
      if (known < floor) steps.delete(known);
    }
  };

  const sweep = (now: number, floor: number): void => {
    lastSweepStep = now;
    for (const [subject, steps] of used) {
      prune(steps, floor);
      if (steps.size === 0) used.delete(subject);
    }
    if (used.size <= cap) return;
    // Map iteration is insertion order and `remember` re-files the subject it touches, so this
    // sort — stable by specification — breaks a tie on the newest step by least recently seen.
    // Both keys point the same way: the subject who just proved a code is the last one out.
    const furthest = [...used.entries()].sort((a, b) => newestStep(a[1]) - newestStep(b[1]));
    for (const [subject] of furthest) {
      if (used.size <= evictTo) break;
      used.delete(subject);
    }
  };

  return {
    get size() {
      return used.size;
    },
    isUsed: (subject, step) => used.get(subject)?.has(step) === true,
    remember: (subject, step, at) => {
      const now = totpStep(at);
      const floor = now - drift;
      const steps = used.get(subject) ?? new Set<number>();
      prune(steps, floor);
      steps.add(step);
      // Deleted before it is set, so this subject moves to the back of the iteration order and
      // that order is least-recently-remembered first. Nothing else observes it.
      used.delete(subject);
      used.set(subject, steps);
      if (used.size > cap || now - lastSweepStep >= SWEEP_EVERY_STEPS) sweep(now, floor);
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
