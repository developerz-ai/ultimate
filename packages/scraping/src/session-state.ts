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
  /**
   * Headers the HTTP leg must send to stay the same client — user-agent, language, site tokens.
   *
   * Only an OFFLINE driver can fill it: CDP exposes no read for "the headers this site now
   * expects", so the puppeteer driver answers `{}` and `driver-parity.test.ts` pins the
   * divergence. A token the HTTP leg must carry belongs on the request (`http.request(url, {
   * headers })`), not here — a fixture that proves otherwise proves it only offline.
   */
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
 * 64 bits of hex. A collision here is one account's cookies restored into a run acting as
 * another, so the width is chosen against that and not against convenience: two distinct segments
 * reach a 1% chance of sharing a digest at ~600 million of them. SHA-256 because its output is
 * fixed by its specification — a key minted by one Bun version has to still address the session
 * the previous one wrote, which `Bun.hash`'s families do not promise.
 */
const SEGMENT_DIGEST_CHARS = 16;

/**
 * One part of the key: readable, path-safe, and INJECTIVE — distinct inputs, distinct segments.
 *
 * The sanitised half is for a human reading a bucket listing. The digest is what makes it a key:
 * `replaceAll(/[^a-zA-Z0-9._-]+/g, '-')` alone COLLAPSES, so `alice@corp.com` and
 * `alice-corp.com` were one segment, `acct/1` and `acct-1` were one segment, and tenants
 * `acme corp` and `acme-corp` were one key space. Every one of those is account A's authenticated
 * session handed to a run acting as account B — `auth.validate()` answers true, because the
 * session IS valid, for the wrong account.
 *
 * Encode rather than collapse, the reasoning `packages/action/src/idempotency-key.ts` states for
 * its JSON tuple: a value that is app data must not be able to spell another value. A JSON tuple
 * cannot be used here because the key is ALSO a storage path — the tenant-first prefix is what an
 * object-store policy scopes — and percent-encoding cannot either, because `%2f` is exactly what
 * `assertSafeKey` refuses. Sanitise for the eye, digest for the identity.
 *
 * Traversal was never what the collapse bought: `assertSafeKey` refuses a `..` segment and still
 * does. The suffix means no segment can BE `..` in the first place.
 */
const encodeSegment = (raw: string): string =>
  `${raw.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')}.${new Bun.CryptoHasher('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, SEGMENT_DIGEST_CHARS)}`;

/**
 * The two absent cases, as literals rather than as encoded strings — which is what keeps them
 * unambiguous. Every encoded segment ends in `.` plus 16 hex characters, and neither of these
 * does, so no tenant called `no-tenant` and no `auth.key` returning `default` can land in the
 * key space that means "there was none".
 */
const NO_TENANT = 'no-tenant';
const NO_DISCRIMINATOR = 'default';

/**
 * Per tenant, per scrape, per site. The tenant is FIRST because the key is also a storage path,
 * and a prefix that starts with the tenant is one an object-store policy can scope.
 *
 * CHANGES EXISTING KEYS. A session stored under the pre-2026-08-24 spelling is not found under
 * this one, which reads as a cache miss: the run logs in again and writes the new key. No failure,
 * no error, one extra login per stored session — and the old objects are orphaned until the
 * bucket's own lifecycle rule collects them.
 */
export function sessionKeyFor(input: {
  readonly scrape: string;
  readonly tenant: string | undefined;
  readonly discriminator?: string | undefined;
}): string {
  return [
    input.tenant === undefined ? NO_TENANT : encodeSegment(input.tenant),
    encodeSegment(input.scrape),
    input.discriminator === undefined ? NO_DISCRIMINATOR : encodeSegment(input.discriminator),
  ].join('/');
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

/**
 * A stored cookie is somebody else's JSON. `name` and `value` are what makes it a cookie at all;
 * the four scope fields `ScrapeCookie` REQUIRES are completed here rather than asserted.
 *
 * Asserting them was the bug: this was a `value is ScrapeCookie` predicate that checked two of
 * that type's six required fields, so a stored `{ name, value }` left `parseSessionState` typed as
 * a whole cookie with no `domain` — and `cookieHeaderFor`, a public export, hands it to
 * `cookieDomainMatches`, which calls `.trim()` on it and throws a bare `TypeError`.
 *
 * The defaults are the ones `cookie-scope.ts` already documents. An empty `domain` matches NO
 * host, which is the point: an unscoped cookie must reach nothing, because the only other way to
 * scope it is to infer the domain from whichever URL is asking, and that is exactly how a
 * `bank.test` session cookie reaches `evilbank.test`. `/` is §5.1.4's reading of an absent path,
 * and an attribute a jar never wrote is `false`.
 */
const toCookie = (value: unknown): ScrapeCookie | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Partial<ScrapeCookie>;
  if (typeof entry.name !== 'string' || typeof entry.value !== 'string') return undefined;
  return {
    name: entry.name,
    value: entry.value,
    domain: typeof entry.domain === 'string' ? entry.domain : '',
    path: typeof entry.path === 'string' ? entry.path : '/',
    ...(typeof entry.expires === 'number' ? { expires: entry.expires } : {}),
    httpOnly: entry.httpOnly === true,
    secure: entry.secure === true,
  };
};

/** Stored JSON is `unknown`. Read structurally, and answer `undefined` rather than half a session. */
export function parseSessionState(raw: unknown, key: string): SessionState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<SessionState>;
  if (!Array.isArray(value.cookies) || typeof value.savedAt !== 'string') return undefined;
  return {
    key,
    savedAt: value.savedAt,
    ...(typeof value.refusedAt === 'string' ? { refusedAt: value.refusedAt } : {}),
    cookies: value.cookies.flatMap((cookie: unknown) => toCookie(cookie) ?? []),
    headers: value.headers ?? {},
    storage: value.storage ?? {},
    userAgent: value.userAgent ?? '',
    origin: value.origin ?? '',
  };
}
