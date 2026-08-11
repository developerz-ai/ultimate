// Single responsibility: session lifetime and the cookie that carries it. Two expiries are
// evaluated independently — `absoluteExpiresAt` is a ceiling activity can never push out, and
// `idleTtlMs` measures from `lastSeenAt` — because sliding-only expiry means a stolen session
// lives forever. `RequestLike`/`CookieJar` are structural on purpose: `@ultimat3/http` binds
// to them without this package importing it (same-tier packages must not depend on each other).

import type { Clock } from '@ultimat3/core';
import type { AuthSession, SessionStore } from './adapter';
import { sessionExpired, sessionUnknown } from './errors';
import { randomToken, sha256Hex, timingSafeEqual } from './tokens';

export interface SessionPolicy {
  /** Hard ceiling from creation. Never extended. */
  readonly absoluteTtlMs: number;
  /** Measured from `lastSeenAt`, refreshed on every verified request. */
  readonly idleTtlMs: number;
  readonly cookieName: string;
  /** Mint a new session id whenever roles/scopes change — closes session fixation. */
  readonly rotateOnPrivilegeChange: boolean;
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

  const touched = await runtime.store.updateSession(session.id, {
    lastSeenAt: now,
    ip: observed?.ip ?? session.ip,
    userAgent: observed?.userAgent ?? session.userAgent,
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
 */
export function sessionCookie(
  token: string,
  policy: SessionPolicy,
  options?: SessionCookieOptions,
): string {
  const name = options?.name ?? policy.cookieName;
  const maxAge = options?.maxAgeSeconds ?? Math.floor(policy.absoluteTtlMs / 1000);
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Same attributes, empty value, `Max-Age=0` — a mismatched attribute set leaves a live twin. */
export function clearSessionCookie(policy: SessionPolicy, name?: string): string {
  return `${name ?? policy.cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** The one `Cookie:` parser in this package — the oauth handshake reads through it too. */
export function readCookie(request: RequestLike, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return decodeURIComponent(part.slice(equals + 1).trim());
  }
  return null;
}

export function readSessionCookie(request: RequestLike, policy: SessionPolicy): string | null {
  return readCookie(request, policy.cookieName);
}
