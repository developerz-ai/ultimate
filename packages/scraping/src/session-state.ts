// The session: what an authenticated browser carries, as a value that can be persisted, restored,
// validated and BURNED.
//
// Reuse is both the fast path and the safe path — logging in on every run is slow and is itself
// the signal anti-bot systems look for. Burning is the counter-intuitive half and it is
// evidence-backed: a persisted profile that has been flagged stays flagged, so a retry that
// reloads it re-trips the same block, forever. "New identity, from scratch" has to be one call.
//
// Session material is CREDENTIAL material. It is tenant-scoped, it never reaches a log line, an
// event field, an artifact or a screenshot, and it is summarised for logs by `sessionDigest()` —
// counts and an origin, never a value.

import type { StorageDriver } from '@ultimat3/storage';
import { assertSafeKey } from '@ultimat3/storage';
import type { ScrapeCookie } from './target';

export interface SessionSnapshot {
  readonly cookies: readonly ScrapeCookie[];
  /** Headers the HTTP leg must send to stay the same client — user-agent, language, site tokens. */
  readonly headers: Readonly<Record<string, string>>;
  /** `localStorage`, flattened. Many sites keep the bearer token here and not in a cookie. */
  readonly storage: Readonly<Record<string, string>>;
  readonly userAgent: string;
  /** The origin this session belongs to. A session is never replayed against another one. */
  readonly origin: string;
}

export interface SessionState extends SessionSnapshot {
  readonly key: string;
  /** ISO 8601. What a `maxAge` on reuse is measured against. */
  readonly savedAt: string;
  /**
   * ISO 8601, set when this site REFUSED these credentials — and the reason the record survives
   * the failure instead of being deleted with it.
   *
   * A site that locks an account after three wrong attempts makes a retrying framework the thing
   * that destroys the user's account. Two mechanisms stop that, at two different distances, and
   * this is the near one:
   *
   * | Mechanism | Stops | Cost still paid |
   * |---|---|---|
   * | `X_SCRAPE_AUTH_FAILED` registered `terminal` (`errors.ts`) | the NEXT attempt — `executeJob` reads the thrown code's classification and dead-letters on the attempt that failed | this attempt ran in full: process, CDP attach, navigation, one wrong password at the site |
   * | this field | THIS attempt, before `driver.open()` — `restorableSession()` reads it first | nothing; the run refuses without a browser and without a request |
   *
   * So the queue-level classification is what makes the failure terminal, and this is what makes
   * the failure CHEAP: a replay after a worker restart, a manual `x jobs retry`, or any second
   * enqueue of the same input never reaches a login form at all. Clearing it is deliberate —
   * `burn()` — because the thing that fixed it was a human changing the credential.
   */
  readonly refusedAt?: string | undefined;
}

export const EMPTY_SESSION: SessionSnapshot = Object.freeze({
  cookies: [],
  headers: {},
  storage: {},
  userAgent: '',
  origin: '',
});

/**
 * Per tenant, per scrape, per site. The tenant is FIRST because the key is also a storage path,
 * and a prefix that starts with the tenant is one an object-store policy can scope.
 */
export function sessionKeyFor(input: {
  readonly scrape: string;
  readonly tenant: string | undefined;
  readonly discriminator?: string | undefined;
}): string {
  const parts = [input.tenant ?? 'no-tenant', input.scrape, input.discriminator ?? 'default'];
  return parts.map((part) => part.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')).join('/');
}

/** What a log line may say about a session: shape, never content. */
export const sessionDigest = (
  state: SessionSnapshot | undefined,
): Readonly<Record<string, unknown>> =>
  state === undefined
    ? { session: 'none' }
    : {
        session: 'present',
        origin: state.origin,
        cookies: state.cookies.length,
        storageKeys: Object.keys(state.storage).length,
      };

export interface ScrapeSessionStore {
  load(key: string): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  /** Delete it. Called on a block, and by an author who knows the identity is spent. */
  burn(key: string): Promise<void>;
}

export function memorySessionStore(
  seed: Readonly<Record<string, SessionState>> = {},
): ScrapeSessionStore {
  const states = new Map<string, SessionState>(Object.entries(seed));
  return {
    load: (key) => Promise.resolve(states.get(key)),
    save: (state) => {
      states.set(state.key, state);
      return Promise.resolve();
    },
    burn: (key) => {
      states.delete(key);
      return Promise.resolve();
    },
  };
}

export const DEFAULT_SESSION_PREFIX = 'scrape-session';

/**
 * Sessions on the app's own disk, through `@ultimat3/storage` — the seam that already knows about
 * tenant-scoped keys and refuses one that escapes its prefix. This package owns no upload path.
 *
 * NOT encrypted at rest: the bytes are as sensitive as the bucket they sit in, so the bucket must
 * be private. Sealing them under core's secrets envelope is the obvious next step and is
 * deliberately not guessed at here — it needs a key the app declares, and a wrong guess about
 * where that key lives is worse than the honest note.
 */
export function storageSessionStore(
  storage: StorageDriver,
  options: { readonly prefix?: string | undefined } = {},
): ScrapeSessionStore {
  const keyFor = (key: string): string => {
    const path = `${options.prefix ?? DEFAULT_SESSION_PREFIX}/${key}.json`;
    assertSafeKey(path);
    return path;
  };
  return {
    async load(key: string): Promise<SessionState | undefined> {
      try {
        const read = await storage.get(keyFor(key));
        return parseSessionState(JSON.parse(new TextDecoder().decode(read.bytes)) as unknown, key);
      } catch {
        // A session that cannot be read is a session that does not exist. Refusing the run over a
        // missing cache would make reuse — the fast path — the fragile path.
        return undefined;
      }
    },
    async save(state: SessionState): Promise<void> {
      await storage.put(keyFor(state.key), new TextEncoder().encode(JSON.stringify(state)), {
        contentType: 'application/json',
      });
    },
    async burn(key: string): Promise<void> {
      await storage.delete(keyFor(key));
    },
  };
}

const isCookie = (value: unknown): value is ScrapeCookie =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { value?: unknown }).value === 'string';

/** Stored JSON is `unknown`. Read structurally, and answer `undefined` rather than half a session. */
export function parseSessionState(raw: unknown, key: string): SessionState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<SessionState>;
  if (!Array.isArray(value.cookies) || typeof value.savedAt !== 'string') return undefined;
  return {
    key,
    savedAt: value.savedAt,
    ...(typeof value.refusedAt === 'string' ? { refusedAt: value.refusedAt } : {}),
    cookies: value.cookies.filter((cookie): cookie is ScrapeCookie => isCookie(cookie)),
    headers: value.headers ?? {},
    storage: value.storage ?? {},
    userAgent: value.userAgent ?? '',
    origin: value.origin ?? '',
  };
}
