// Single responsibility: structured JSON logging. One line per event, machine-readable by
// default because the primary reader is an agent tailing `x logs --json`.

import { assert } from './assert';
import { type Clock, systemClock } from './clock';
import { renderCauseValue } from './error-render';
import { isUltimateError } from './errors';
import { isSecret, REDACTED } from './secret';

// Re-exported, not redefined: `secret.ts` owns the placeholder because a `Secret` has to render
// it without importing the logger, and two constants spelled the same is one rename from a leak.
export { REDACTED } from './secret';

/** What a `Date` this file cannot render says instead — the line survives, the value is named. */
const INVALID_DATE = 'an invalid Date';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT = Object.freeze<Record<LogLevel, number>>({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
});

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Bind fields onto every subsequent line. Child fields win over parent fields. */
  child(fields: LogFields): Logger;
  withLevel(level: LogLevel): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel | undefined;
  readonly fields?: LogFields | undefined;
  readonly clock?: Clock | undefined;
  /** Receives one complete JSON line (no trailing newline). Defaults to stdout/stderr. */
  readonly writer?: ((line: string, level: LogLevel) => void) | undefined;
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
const CREDENTIAL_NAME = new RegExp(
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
}

/**
 * The framework's ONE answer to "is this field a credential?" — the log line, the error monitor's
 * envelope and `@ultimat3/action`'s audit row all ask it, so a value that is `[redacted]` in one
 * cannot be plaintext in another.
 */
export function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return redactedKeys.has(lower) || CREDENTIAL_NAME.test(lower.replace(/[_-]/g, ''));
}

/**
 * Fields injected into every line — set once by `context.ts` so `requestId`/`traceId` appear
 * without threading the context into every call site.
 */
let contextFields: () => LogFields | undefined = () => undefined;

export function setLoggerContextFields(provider: () => LogFields | undefined): void {
  contextFields = provider;
}

/**
 * Where a line with no explicit writer lands, for everything below `error`. A fact about the
 * PROCESS and not about the line: a container's stdout IS its log stream (12-factor), while a
 * CLI's stdout is the answer it was asked for. `x db migrate --json` printed the boot logger's
 * `ultimate migrate applied` and then the command's own JSON to fd 1, so a caller doing what
 * `--json` exists for — parsing the output — raised on the second object.
 */
let logStream: 'stdout' | 'stderr' = 'stdout';

/**
 * Send everything below `error` to stderr, or back to stdout. The process's own call, made once at
 * entry: a per-line choice would be the second logging path axiom 1 refuses, and a per-logger one
 * already exists as `LoggerOptions.writer` — what had no seam is the module-scope `logger`, which
 * is the one `serve.ts` and every boot path write through.
 */
export function setLogStream(stream: 'stdout' | 'stderr'): void {
  logStream = stream;
}

/** What `setLogSink` installs: one complete JSON line, and the level it was written at. */
export type LogSink = (line: string, level: LogLevel) => void;

let logSink: LogSink | undefined;

/**
 * TEST SEAM. Every line with no explicit `writer` goes to `sink` INSTEAD of the process's streams,
 * until it is cleared with `undefined`. Returns the sink that was installed, so a caller restores
 * rather than clears — the shape `setRowObserver` has, for the same shared-process reason.
 *
 * It exists for two callers. A test preload installs a sink that drops every line, so a green run
 * prints its reporter and nothing else; and a test that asserts on what the PROCESS logger wrote
 * installs one that collects, instead of patching `process.stdout`. A logger given its own
 * `writer` never reaches it, and the level is untouched: this decides where a line goes, never
 * whether it is written.
 */
export function setLogSink(sink: LogSink | undefined): LogSink | undefined {
  const previous = logSink;
  logSink = sink;
  return previous;
}

/**
 * The second half of the same defect, one call deeper than `envLevel`. A module init made safe
 * that still reached `process.stdout` here would only move the `ReferenceError` from load to the
 * first line written — and the framework's own client code writes one: `@ultimat3/realtime`'s
 * `channel.ts` calls `logger.warn('channel.guard_failed', …)` in the browser. That package already
 * says so out loud at `client.ts:51` — "the default reporter: `console.error`, never core's
 * `logger` — that writes `process.stderr`" — a workaround for a hazard that belongs here, in the
 * one file that owns the sink.
 *
 * `console` is the browser's stream pair, kept on the same `toStderr` split so a level does not
 * change lane between runtimes. It is a fallback and never a preference: a container's stdout IS
 * its log stream, and where there is a `process` this writes to the fd as it always did.
 */
function defaultWriter(line: string, level: LogLevel): void {
  if (logSink !== undefined) {
    logSink(line, level);
    return;
  }
  const toStderr = logStream === 'stderr' || LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.error;
  if (typeof process === 'undefined') {
    if (toStderr) console.error(line);
    else console.log(line);
    return;
  }
  const stream = toStderr ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
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

/**
 * The last guard. The walk above already degraded every hostile field, so reaching the fallback
 * means the assembled line itself refused to serialise — and the answer to that is still a line,
 * not a throw propagating out of `log.error` into whatever `catch` block called it.
 */
function renderLine(
  line: Readonly<Record<string, unknown>>,
  level: LogLevel,
  message: string,
  ts: unknown,
): string {
  try {
    return JSON.stringify(line);
  } catch {
    return JSON.stringify({
      ts: typeof ts === 'string' ? ts : '',
      level,
      msg: message,
      logFields: 'a log line that cannot be serialised',
    });
  }
}

/**
 * The one value in a line that is not the caller's, and it was the one read left unguarded:
 * `toISOString()` raises `RangeError` on an invalid `Date`, and a `Clock` is injected — a frozen
 * clock set from a bad string, or a clock whose `now()` throws, took the whole line with it. The
 * same marker `serialise` gives an invalid `Date` in a FIELD, so one vocabulary covers both.
 */
function timestamp(clock: Clock): string {
  try {
    const at = clock.now();
    if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString();
  } catch {
    // A clock that fights being read is exactly the moment a line is worth keeping.
  }
  return INVALID_DATE;
}

/**
 * `LOG_LEVEL`, and the default where there is no environment to read it from.
 *
 * A BROWSER has no `process` binding at all, and this read runs at MODULE INIT — `logger` at the
 * foot of this file is `createLogger()` evaluated when the module is. Measured on ai-maxxing's
 * session console island: `@ultimat3/realtime`'s `channel.ts` calls `logger.warn`, so the shaker
 * keeps `logger`, and the island's chunk died on `ReferenceError: process is not defined` before a
 * line of the app's own code ran — the wrapper rendered `data-x-failed="process is not defined"`
 * and the island never mounted. `info` is what a browser gets, and it is the right answer: there
 * is no environment there to have said otherwise.
 *
 * `typeof`, and never an optional chain. Optional chaining guards a value that is NULLISH, not a
 * binding that is UNDECLARED, so a bare `process?.env` throws the very `ReferenceError` it looks
 * like it is preventing. `globalThis.process?.env` does not throw — that is a property access on
 * an object that exists, and it answers `undefined` — but it is still the wrong form here: it
 * differs from the throwing one by a prefix, so which of the two a reader is looking at is not
 * visible at a glance, and one of them is a browser crash. `typeof` is the single form that is
 * safe on a bare identifier, and it is what `version.ts` already uses for
 * `ULTIMATE_FRAMEWORK_VERSION` — one way to do each thing.
 */
function envLevel(): LogLevel {
  const raw = typeof process === 'undefined' ? undefined : process.env['LOG_LEVEL'];
  // Unset and EMPTY are the same answer — `LOG_LEVEL=` is how a compose file spells "not set".
  if (raw === undefined || raw === '') return 'info';
  // REFUSED, as `resolveLevel` refuses the same value from `createLogger({ level })`. It fell back
  // to `info` in silence, so `LOG_LEVEL=verbose` — or `DEBUG`, the spelling half the ecosystem
  // uses — gave an operator who asked for MORE lines fewer, and nothing said the variable was the
  // reason. This runs at module init, so the refusal is the first thing the process prints.
  assert(
    (LOG_LEVELS as readonly string[]).includes(raw),
    `LOG_LEVEL=${renderCauseValue(raw)} is not a log level`,
    `set LOG_LEVEL=info (one of ${LOG_LEVELS.join(', ')}, lowercase), or unset LOG_LEVEL`,
  );
  return raw as LogLevel;
}

/**
 * The level this logger enforces, refused when it is not one.
 *
 * `LEVEL_WEIGHT[level]` on anything else is `undefined`, and every `weight < undefined` is false —
 * so the threshold failed OPEN and the logger emitted every line at every level. That is a `trace`
 * stream out of a production process from one typo, which is the direction this read must never
 * fail in. `LOG_LEVELS`, the same list `envLevel()` filters `LOG_LEVEL` through, because a level
 * is typed here and arrives untyped: an `app.config.ts` value, a JSON file, a CLI flag.
 */
function resolveLevel(declared: LogLevel): LogLevel {
  assert(
    (LOG_LEVELS as readonly unknown[]).includes(declared),
    // `renderCauseValue`, never `JSON.stringify`: it raises on a bigint and on a cycle, and a
    // level that arrived from a config file can be either — the refusal must not be replaced by
    // a `TypeError` from building its own message.
    `${renderCauseValue(declared)} is not a log level`,
    `pass one of ${LOG_LEVELS.join(', ')} to createLogger({ level })`,
  );
  return declared;
}

/** The keys a line owns. A caller field spelled like one is renamed, never allowed to replace it. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['ts', 'level', 'msg']);

/**
 * The caller's fields with any reserved key moved to `field.<key>`. Spread after `level`, a field
 * `{ level: 'debug' }` turned an `error` line into a `debug` one, so a level-filtered alert never
 * saw it. Renamed rather than dropped: the value is still evidence.
 */
function unreserved(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[RESERVED_KEYS.has(key) ? `field.${key}` : key] = value;
  }
  return out;
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level === undefined ? envLevel() : resolveLevel(options.level);
  const bound = options?.fields ?? {};
  const clock = options?.clock ?? systemClock;
  const writer = options?.writer ?? defaultWriter;
  const threshold = LEVEL_WEIGHT[level];

  function emit(lineLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[lineLevel] < threshold) return;
    const caller = {
      ...redactFields(bound),
      ...redactFields(contextFields() ?? {}),
      ...redactFields(fields ?? {}),
    };
    const line = {
      ts: timestamp(clock),
      level: lineLevel,
      msg: message,
      ...unreserved(caller),
    };
    writer(renderLine(line, lineLevel, message, line.ts), lineLevel);
  }

  return {
    level,
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    fatal: (message, fields) => emit('fatal', message, fields),
    child: (fields) => createLogger({ level, clock, writer, fields: { ...bound, ...fields } }),
    withLevel: (next) => createLogger({ level: next, clock, writer, fields: bound }),
  };
}

/** The process-wide logger. Prefer `ctx.logger` inside a request — it carries the ids. */
export const logger: Logger = createLogger();
