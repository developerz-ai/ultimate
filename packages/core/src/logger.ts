// Single responsibility: structured JSON logging. One line per event, machine-readable by
// default because the primary reader is an agent tailing `x logs --json`.

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

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = Object.freeze({
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
 * LOWERCASE, always: `isRedactedKey` lowercases its lookup, so `apiKey`/`accessToken`/
 * `refreshToken` sat here for three releases matching nothing — and those are the exact field
 * names on `@ultimat3/auth`'s `OAuthTokens`. Matching is exact-key and never substring, so a
 * spelling that is not in this set is not redacted: both the camel and the snake wire spelling of
 * each credential is listed. Add through `redactKeys()` (which lowercases) rather than here.
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
]);

/** Mark keys as secret everywhere. `defineEnv()` calls this for every `secret: true` var. */
export function redactKeys(keys: Iterable<string>): void {
  for (const key of keys) redactedKeys.add(key.toLowerCase());
}

export function isRedactedKey(key: string): boolean {
  return redactedKeys.has(key.toLowerCase());
}

/**
 * Fields injected into every line — set once by `context.ts` so `requestId`/`traceId` appear
 * without threading the context into every call site.
 */
let contextFields: () => LogFields | undefined = () => undefined;

export function setLoggerContextFields(provider: () => LogFields | undefined): void {
  contextFields = provider;
}

function defaultWriter(line: string, level: LogLevel): void {
  const stream = LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.error ? process.stderr : process.stdout;
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

function redactFields(fields: LogFields): Record<string, unknown> {
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

function envLevel(): LogLevel {
  const raw = process.env['LOG_LEVEL'];
  return raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : 'info';
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level ?? envLevel();
  const bound = options?.fields ?? {};
  const clock = options?.clock ?? systemClock;
  const writer = options?.writer ?? defaultWriter;
  const threshold = LEVEL_WEIGHT[level];

  function emit(lineLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[lineLevel] < threshold) return;
    const line = {
      ts: timestamp(clock),
      level: lineLevel,
      msg: message,
      ...redactFields(bound),
      ...redactFields(contextFields() ?? {}),
      ...redactFields(fields ?? {}),
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
