// Single responsibility: structured JSON logging. One line per event, machine-readable by
// default because the primary reader is an agent tailing `x logs --json`.

import { type Clock, systemClock } from './clock';
import { isUltimateError } from './errors';

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

export const REDACTED = '[redacted]';

const redactedKeys = new Set<string>([
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apiKey',
  'accessToken',
  'refreshToken',
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

function serialiseValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (isUltimateError(value)) return value.toJSON();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => serialiseValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isRedactedKey(key) ? REDACTED : serialiseValue(nested, depth + 1);
  }
  return out;
}

function redactFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isRedactedKey(key) ? REDACTED : serialiseValue(value, 0);
  }
  return out;
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
      ts: clock.now().toISOString(),
      level: lineLevel,
      msg: message,
      ...redactFields(bound),
      ...redactFields(contextFields() ?? {}),
      ...redactFields(fields ?? {}),
    };
    writer(JSON.stringify(line), lineLevel);
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
