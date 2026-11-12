// Single responsibility: what a log line may carry — the one answer to "is this field a
// credential?" (`isRedactedKey`) and the walk that makes a caller's record safe to serialise and
// safe to ship (`redactFields`). Split out of `logger.ts`, which writes the line.

import { renderCauseValue } from './error-render';
import { isUltimateError } from './errors';
import { isSecret, REDACTED } from './secret';

/** What a `Date` this file cannot render says instead — the line survives, the value is named. */
export const INVALID_DATE = 'an invalid Date';

/** A caller's field record. Declared here, re-exported by `logger.ts`, so neither imports a cycle. */
export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * The exact-key FAST PATH. LOWERCASE, always: `isRedactedKey` lowercases its lookup, so
 * `apiKey`/`accessToken`/`refreshToken` sat here for three releases matching nothing — and those
 * are the exact field names on `@ultimat3/auth`'s `OAuthTokens`. Add through `redactKeys()` (which
 * lowercases) rather than here. A name this set misses still meets `CREDENTIAL_NAME` below.
 */
const redactedKeys = new Set<string>([
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessiontoken',
  'session_token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  // The framework's own columns (`@ultimat3/auth`): a hash is what an offline guess runs against.
  'passwordhash',
  'tokenhash',
  'keyhash',
]);

/**
 * The second half, for the names no list can enumerate. Exact-key matching alone let every
 * COMPOUND credential through — `currentPassword`, `mfaSecret`, `resetToken`, `recoveryCode` — and
 * `@ultimat3/action`'s audit walk asks this same predicate, so each was persisted in clear.
 *
 * Tested against the key lowercased with `_` and `-` removed, so one pattern covers the camel, the
 * snake and the header spelling. It names what BEARS a credential and nothing wider, because a
 * redacted field is one an operator cannot correlate on:
 *
 * - `password` / `passphrase` anywhere — no ordinary field carries the word.
 * - `secret` as the LAST word (`mfaSecret`, `webhookSecret`, `appSecrets`, `secretAccessKey`), so
 *   `clientSecretEnv` and `secretsPath` — a variable name and a path — stay readable.
 * - a `token` is a bearer UNLESS its qualifier says it is not: fail closed, with the exceptions
 *   named. `idempotencyToken`, `pageToken`, `continuationToken`, `cursorToken`, `syncToken` are
 *   dedupe and paging keys an operator greps for; everything else ending in `token` — `resetToken`,
 *   `githubToken`, `NPM_TOKEN` — is redacted without a provider list to keep current. The PLURAL
 *   is the reverse: `maxTokens` / `inputTokens` are counts on every `@ultimat3/ai` usage line, so
 *   `tokens` is redacted only behind a bearer qualifier (`accessTokens`).
 * - key MATERIAL by its qualifier (`apiKey`, `privateKey`, `signingKey`, `encryptionKey`,
 *   `masterKey`, `hmacKey`, `secretsKey`, `accessKey`, `retiredKeys`) and the id half of a key
 *   pair (`accessKeyId`). A LOOKUP key — `cacheKey`, `primaryKey`, `idempotencyKey` — and a key's
 *   own id (`signingKeyId`) carry no qualifier on this list and stay readable.
 * - a value that EMBEDS a credential: `connectionString`, `dsn`, a registry `authConfig`, and the
 *   service URLs that carry `user:password@` (`databaseUrl`, `REDIS_URL`). A bare `url` does not.
 * - the one-time codes by name. Never a `code` suffix: that is the error contract's own field.
 * - a stored hash of any of them: it is what an offline guess runs against.
 * - a bearer by its kind as the LAST word: `credentials`, `jwt`, `bearer`, `cookies`, a session's
 *   id or key (`sessionId` IS the session), and key material by encoding (`privateKeyPem`).
 *   `credentialId`, `jwtIssuer`, `cookieName`, `privateKeyId` name a credential, not hold one.
 * - card verification codes (`cvv`, `cvc2`) as a suffix, and a `pin` only as the WHOLE word
 *   behind an owner qualifier — three letters inside `spinner`, `shipping` or `pinned` are not one.
 *
 * Built from constant alternatives with no nested quantifier, so there is no input it backtracks on.
 */
/**
 * The verdict per key AS WRITTEN, so a repeat skips the lower-casing too. A line asks it for every
 * key, every time: 249 ns a key through the regex, a handful of distinct keys per process in practice.
 */
const verdicts = new Map<string, boolean>();

/** Exported for its own work-count test only (`logger-redact.test.ts`); never on the barrel. */
export const CREDENTIAL_NAME = new RegExp(
  [
    'passw(?:or)?d|passphrase',
    'secrets?$',
    '(?:api|private|signing|encryption|master|hmac|secrets?|access|retired)keys?$|accesskeyid$',
    '(?:token|key)hash(?:es)?$',
    '(?<!idempotency|page|continuation|cursor|sync)token$',
    '(?:access|refresh|id|session|reset|bearer|auth|api|csrf|xsrf|captcha|card|verification|invite|magic|magiclink|device|push|workload|oauth)tokens$',
    'authconfig$|connectionstring$|dsn$',
    '(?:database|db|redis|replication|nats|smtp|amqp|mongo)ur[li]s?$',
    '^totp$|totpcode$|otp$|otpcode$',
    '(?:recovery|backup|mfa)codes?(?:hash(?:es)?)?$',
    'credentials?$|jwts?$|bearer$|cookies?$|session(?:id|key)s?$',
    'privatekey(?:pem|der|jwk)$',
    'cv[vc]2?$',
    '^(?:card|atm|security|account|user|wallet)?pin(?:code|number)?(?:hash(?:es)?)?$',
  ].join('|'),
);

/** Mark keys as secret everywhere. `defineEnv()` calls this for every `secret: true` var. */
export function redactKeys(keys: Iterable<string>): void {
  for (const key of keys) redactedKeys.add(key.toLowerCase());
  // A key memoised as readable before it was declared secret must not stay readable — and neither
  // may a field a logger redacted when it was bound: the generation tells it to redact again.
  verdicts.clear();
  generation += 1;
}

/** Bumped by every `redactKeys` call. A snapshot redacted at an older generation is stale. */
let generation = 0;

/** The current redaction generation: one integer compare is the whole cost of staying current. */
export function redactionGeneration(): number {
  return generation;
}

/** How many key verdicts are remembered. Past it the oldest is forgotten and asked again. */
export const REDACTION_MEMO_SIZE = 4096;

/**
 * The framework's ONE answer to "is this field a credential?" — the log line, the error monitor's
 * envelope and `@ultimat3/action`'s audit row all ask it, so a value that is `[redacted]` in one
 * cannot be plaintext in another.
 */
export function isRedactedKey(key: string): boolean {
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const lower = key.toLowerCase();
  const verdict = redactedKeys.has(lower) || CREDENTIAL_NAME.test(lower.replace(/[_-]/g, ''));
  // Insertion order is age, so the first key is the oldest: FIFO, no bookkeeping per hit. Bounded
  // because a key is caller data — a request body's own keys reach `redactFields`.
  if (verdicts.size >= REDACTION_MEMO_SIZE) verdicts.delete(verdicts.keys().next().value ?? '');
  verdicts.set(key, verdict);
  return verdict;
}

/**
 * TOTAL, on purpose. `lifecycle.ts` logs the value a shutdown hook threw and the value a
 * readiness check threw — both caught, both arbitrary — so a renderer that throws here escapes
 * `runPhase`'s catch, rejects the drain promise, and `installSignalHandlers` never reaches
 * `process.exit(0)`: SIGTERM hangs, and `/readyz` dies with the check it was reporting on. A log
 * line must never replace the event it describes.
 *
 * Degradation is per KEY, the same shape `renderMetaRecord` uses: one hostile getter must not
 * cost a reader the fields beside it.
 */
function serialiseValue(value: unknown, depth: number): unknown {
  try {
    return serialise(value, depth);
  } catch {
    // `instanceof`, `Object.keys` and `toJSON` are all property reads on a value the framework
    // did not build; `renderCauseValue` is the one renderer that cannot itself throw.
    return renderCauseValue(value);
  }
}

function serialise(value: unknown, depth: number): unknown {
  // `JSON.stringify` raises a `TypeError` on a bigint, so the whole line died for one field.
  if (typeof value === 'bigint') return renderCauseValue(value);
  if (value === null || typeof value !== 'object') return value;
  // Before every other branch: a `Secret` is redacted by VALUE, so it stays redacted under a key
  // nobody listed — `{ dsn: secret(url) }` is the leak key-name redaction cannot see.
  if (isSecret(value)) return REDACTED;
  // `toISOString()` THROWS on an invalid Date, and an invalid Date is exactly the value worth
  // logging when a schedule went wrong.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? INVALID_DATE : value.toISOString();
  }
  if (isUltimateError(value)) return value.toJSON();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => serialiseValue(item, depth + 1));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = isRedactedKey(key) ? REDACTED : entryValue(source, key, depth);
  }
  return out;
}

/** One field. The `try` covers the property READ — `serialiseValue` above is already total. */
function entryValue(source: Record<string, unknown>, key: string, depth: number): unknown {
  try {
    return serialiseValue(source[key], depth + 1);
  } catch {
    return 'a value that cannot be read';
  }
}

/**
 * A caller's record made safe to SERIALISE and safe to SHIP: credentials replaced by key and by
 * value, a bigint / cycle / hostile getter degraded per field. Exported for the one other sink
 * that sends a caller's record off the box — `error-reporter-sentry.ts`.
 */
export function redactFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = fields as Record<string, unknown>;
  // `Object.keys` before the values, so the read of each value is its own guarded step: a field
  // record is the caller's object, and enumerating it eagerly threw on the first hostile getter.
  for (const key of ownKeys(source)) {
    out[key] = isRedactedKey(key) ? REDACTED : entryValue(source, key, 0);
  }
  return out;
}

function ownKeys(source: Record<string, unknown>): readonly string[] {
  try {
    return Object.keys(source);
  } catch {
    return [];
  }
}
