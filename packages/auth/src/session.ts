// Single responsibility: session lifetime and the cookie that carries it. Two expiries are
// evaluated independently — `absoluteExpiresAt` is a ceiling activity can never push out, and
// `idleTtlMs` measures from `lastSeenAt` — because sliding-only expiry means a stolen session
// lives forever. `RequestLike`/`CookieJar` are structural on purpose: `@ultimat3/http` binds
// to them without this package importing it (same-tier packages must not depend on each other).

import type { Clock } from '@ultimat3/core';
import type { AuthSession, SessionStore } from './adapter';
import { sessionExpired, sessionUnknown } from './errors';
import { assertFiniteAuthCount } from './policy-numbers';
import { randomToken, sha256Hex, timingSafeEqual } from './tokens';

export interface SessionPolicy {
  /** Hard ceiling from creation. Never extended. */
  readonly absoluteTtlMs: number;
  /** Measured from `lastSeenAt`, refreshed at most once per `idleSlideMs`. */
  readonly idleTtlMs: number;
  /**
   * How stale `lastSeenAt` may get before a verified request writes it forward. Absent means
   * `idleTtlMs / IDLE_SLIDE_DIVISOR`, derived rather than a constant so an app that shortens
   * `idleTtlMs` does not silently get a slide longer than its own idle window — which would
   * pin every session to its creation time and expire it on the dot.
   *
   * It exists because `verifySession` used to write on EVERY authenticated request: one request
   * was a SELECT, an `UPDATE … RETURNING *` and a second SELECT, before the app's own first
   * query. At 20k rps that is 20k writes a second on one hot table, autovacuum falls behind, and
   * the incident reads as "the database is slow" rather than "authentication is a write path".
   * The trade is bounded: idle expiry is now precise to within one `idleSlideMs`.
   */
  readonly idleSlideMs?: number | undefined;
  readonly cookieName: string;
  /** Mint a new session id whenever roles/scopes change — closes session fixation. */
  readonly rotateOnPrivilegeChange: boolean;
}

/** 20 → roughly 5% of the idle window, so the write rate falls ~20× and the drift stays small. */
export const IDLE_SLIDE_DIVISOR = 20;

/** The resolved slide, wherever it is read. One derivation, so the two readers cannot disagree. */
export function idleSlideMs(policy: SessionPolicy): number {
  return Math.max(0, policy.idleSlideMs ?? Math.floor(policy.idleTtlMs / IDLE_SLIDE_DIVISOR));
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  absoluteTtlMs: 30 * 24 * 60 * 60 * 1000,
  idleTtlMs: 7 * 24 * 60 * 60 * 1000,
  // `__Host-` is a browser-enforced contract: the cookie must be Secure, Path=/ and carry no
  // Domain. A subdomain (or an XSS on one) therefore cannot overwrite it — session fixation.
  cookieName: '__Host-x_session',
  rotateOnPrivilegeChange: true,
});

export interface SessionRuntime {
  readonly store: SessionStore;
  readonly policy: SessionPolicy;
  readonly clock: Clock;
}

export interface RequestLike {
  readonly headers: { get(name: string): string | null };
}

export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, attributes?: Readonly<Record<string, unknown>>): void;
  delete(name: string): void;
}

export interface SessionDevice {
  readonly sessionId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly current: boolean;
}

export interface SessionExpiry {
  readonly absoluteExpired: boolean;
  readonly idleExpired: boolean;
}

export interface IssuedSession {
  readonly session: AuthSession;
  /** Shown once, set as a cookie, never stored. Only its SHA-256 reaches the row. */
  readonly token: string;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly mfaSatisfied?: boolean | undefined;
}

/** `<id>.<secret>`: the id is the row key, the secret is the half that is hashed. */
export function parseSessionToken(token: string): { id: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export async function createSession(
  runtime: SessionRuntime,
  input: CreateSessionInput,
): Promise<IssuedSession> {
  const now = runtime.clock.now();
  const id = randomToken(12);
  const secret = randomToken(32);
  const session = await runtime.store.createSession({
    id,
    userId: input.userId,
    tokenHash: sha256Hex(secret),
    createdAt: now,
    absoluteExpiresAt: new Date(now.getTime() + runtime.policy.absoluteTtlMs),
    lastSeenAt: now,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    mfaSatisfied: input.mfaSatisfied ?? false,
  });
  return { session, token: `${id}.${secret}` };
}

/** The two clocks are computed separately; neither can mask the other. */
export function sessionExpiry(
  session: AuthSession,
  policy: SessionPolicy,
  now: Date,
): SessionExpiry {
  return {
    absoluteExpired: now.getTime() >= session.absoluteExpiresAt.getTime(),
    idleExpired: now.getTime() - session.lastSeenAt.getTime() >= policy.idleTtlMs,
  };
}

/**
 * Resolve a cookie value to a live session, sliding the idle window forward. Throws
 * `X_SESSION_EXPIRED` for either clock and `X_UNAUTHENTICATED` for anything unknown —
 * a forged id and a deleted session are indistinguishable to the caller.
 */
export async function verifySession(
  runtime: SessionRuntime,
  token: string,
  observed?: { readonly ip?: string | null | undefined; readonly userAgent?: string | null },
): Promise<AuthSession> {
  const parsed = parseSessionToken(token);
  if (parsed === null) throw sessionUnknown();
  const session = await runtime.store.getSession(parsed.id);
  if (session === null) throw sessionUnknown();
  if (!timingSafeEqual(sha256Hex(parsed.secret), session.tokenHash)) throw sessionUnknown();

  const now = runtime.clock.now();
  const expiry = sessionExpiry(session, runtime.policy, now);
  if (expiry.absoluteExpired || expiry.idleExpired) {
    await runtime.store.deleteSession(session.id);
    throw sessionExpired(expiry.absoluteExpired ? 'absolute' : 'idle', session.id);
  }

  const ip = observed?.ip ?? session.ip;
  const userAgent = observed?.userAgent ?? session.userAgent;
  // The window slides only when it has actually moved. A second request inside the slide issues
  // no write at all — the read path stays a read — while a changed address or user agent is
  // written immediately, because that is the row a device list and an incident review read.
  const stale = now.getTime() - session.lastSeenAt.getTime() >= idleSlideMs(runtime.policy);
  if (!stale && ip === session.ip && userAgent === session.userAgent) return session;

  const touched = await runtime.store.updateSession(session.id, {
    lastSeenAt: stale ? now : session.lastSeenAt,
    ip,
    userAgent,
  });
  return touched ?? session;
}

/**
 * Privilege change (role grant, MFA satisfied, password change) must not reuse the old id:
 * whoever already holds the old cookie would inherit the new privileges.
 */
export async function rotateSession(
  runtime: SessionRuntime,
  session: AuthSession,
  patch?: { readonly mfaSatisfied?: boolean | undefined },
): Promise<IssuedSession> {
  await runtime.store.deleteSession(session.id);
  return await createSession(runtime, {
    userId: session.userId,
    ip: session.ip,
    userAgent: session.userAgent,
    mfaSatisfied: patch?.mfaSatisfied ?? session.mfaSatisfied,
  });
}

export async function revokeSession(runtime: SessionRuntime, sessionId: string): Promise<boolean> {
  return await runtime.store.deleteSession(sessionId);
}

export async function revokeOtherSessions(
  runtime: SessionRuntime,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  return await runtime.store.deleteOtherSessions(userId, keepSessionId);
}

/** What the "your devices" screen renders. Never includes the token hash. */
export async function listDevices(
  runtime: SessionRuntime,
  userId: string,
  currentSessionId?: string,
): Promise<readonly SessionDevice[]> {
  const sessions = await runtime.store.listSessions(userId);
  return sessions.map((session) => ({
    sessionId: session.id,
    ip: session.ip,
    userAgent: session.userAgent,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    current: session.id === currentSessionId,
  }));
}

export interface SessionCookieOptions {
  readonly name?: string | undefined;
  readonly maxAgeSeconds?: number | undefined;
}

/**
 * Every attribute is load-bearing:
 * - `HttpOnly`  — script cannot read it, so an XSS cannot exfiltrate the session.
 * - `Secure`    — never sent over plaintext, so a network attacker cannot lift it.
 * - `SameSite=Lax` — not attached to cross-site POSTs, which is CSRF's whole mechanism.
 * - `Path=/`, no `Domain` — required by `__Host-`; a sibling subdomain cannot set or read it.
 * - `Max-Age`   — the client drops it at the absolute expiry, matching the server's ceiling.
 *
 * The two numbers behind that last attribute are screened here rather than merged first, because
 * they are two different options and an error naming the one the caller did not pass is a `fix:`
 * nobody can follow. `Max-Age` is `delta-seconds` — digits — so `NaN`, `Infinity` and `1.5` are
 * attributes a browser DISCARDS: the cookie then lives until the tab closes, which is the client
 * half of the session ceiling gone with no error anywhere. Zero is legitimate and stays legal, at
 * both ends: it means "expire now", which is exactly what `clearSessionCookie` emits.
 */
export function sessionCookie(
  token: string,
  policy: SessionPolicy,
  options?: SessionCookieOptions,
): string {
  const name = options?.name ?? policy.cookieName;
  const maxAge =
    options?.maxAgeSeconds === undefined
      ? Math.floor(
          assertFiniteAuthCount(
            'session.absoluteTtlMs',
            policy.absoluteTtlMs,
            'the cookie carries `Max-Age=NaN`, which is not delta-seconds, so the browser drops the attribute and keeps the session cookie for the whole browsing session',
            1,
          ) / 1000,
        )
      : assertFiniteAuthCount(
          'session.cookie.maxAgeSeconds',
          options.maxAgeSeconds,
          'the cookie carries an attribute that is not delta-seconds, so the browser drops it and keeps the session cookie for the whole browsing session',
          0,
        );
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Same attributes, empty value, `Max-Age=0` — a mismatched attribute set leaves a live twin. */
export function clearSessionCookie(policy: SessionPolicy, name?: string): string {
  return `${name ?? policy.cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The one `Cookie:` parser in this package — the oauth handshake reads through it too, so it never
 * throws: a missing or unreadable cookie is `null` or the raw value, never an exception.
 */
export function readCookie(request: RequestLike, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return decodeCookieValue(part.slice(equals + 1).trim());
  }
  return null;
}

/**
 * A `Cookie:` header is attacker-controlled, and `decodeURIComponent('%')` throws a bare
 * `URIError` — which escapes every coded path that reads through here: an OAuth callback would
 * answer 500 instead of `X_OAUTH_STATE_INVALID`. The raw value is returned instead, so the
 * caller's own rejection stays the readable failure. Nothing is loosened by it: a raw value is
 * still checked against a signature or a stored hash, and neither matches a mangled one.
 */
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function readSessionCookie(request: RequestLike, policy: SessionPolicy): string | null {
  return readCookie(request, policy.cookieName);
}
