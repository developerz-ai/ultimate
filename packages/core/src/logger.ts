// Single responsibility: structured JSON logging. One line per event, machine-readable by
// default because the primary reader is an agent tailing `x logs --json`. Every process-logger
// line is also published as `log.record` on the instrumentation bus — the OTLP logs exporter's feed.

import { adapterSlot } from './adapter-slot';
import { assert } from './assert';
import { type Clock, liveClock } from './clock';
import { renderCauseValue } from './error-render';
import { subscribed } from './instrument';
import { publishRecord } from './logger-record';
import { INVALID_DATE, type LogFields, redactFields, redactionGeneration } from './logger-redact';

// The redaction half lives in `logger-redact.ts`; every caller keeps importing it from here.
export type { LogFields } from './logger-redact';
export { isRedactedKey, redactFields, redactKeys } from './logger-redact';
// Re-exported, not redefined: `secret.ts` owns the placeholder because a `Secret` has to render
// it without importing the logger, and two constants spelled the same is one rename from a leak.
export { REDACTED } from './secret';

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

/** What `installLogSink` installs: one complete JSON line, and the level it was written at. */
export type LogSink = (line: string, level: LogLevel) => void;

// `undefined` is a frame too: "the process's streams", so a test whose subject IS the streams can
// lift the preload's sink for its own span without knowing what the preload installed.
const logSinks = adapterSlot<LogSink | undefined>(() => undefined);

/**
 * TEST SEAM. Every line with no explicit `writer` goes to `sink` INSTEAD of the process's streams
 * (`undefined`: to the streams), until the returned release runs. A stack of frames, each removed
 * only by its own release — one `bun test` process is shared, so a test's `finally` hands back
 * whatever an outer harness installed without ever having read it, in any order.
 *
 * It exists for two callers. A test preload installs a sink that drops every line, so a green run
 * prints its reporter and nothing else; and a test that asserts on what the PROCESS logger wrote
 * installs one that collects, instead of patching `process.stdout`. A logger given its own
 * `writer` never reaches it, and the level is untouched: this decides where a line goes, never
 * whether it is written.
 */
export function installLogSink(sink: LogSink | undefined): () => void {
  return logSinks.install(sink);
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
  streamWriter(line, level);
  for (const tee of logTees) {
    try {
      tee(line, level);
    } catch {
      // A log call is TOTAL: a tee that cannot write (a full disk under `dev.log`) costs its own
      // copy of the line, never the caller's `log.error` nor the streams' copy, already written.
    }
  }
}

/** Every installed tee, in install order. A set and never a slot: a second tee joins the first. */
const logTees = new Set<LogSink>();

/**
 * Hand every process-logger line to `tee` AS WELL AS the streams, until the returned release runs.
 * The streams (or an `installLogSink` frame) still get each line, on core's own lanes — a tee adds
 * a copy and decides nothing about where the original goes. `x dev`'s `dev.log` is the caller: a
 * file beside the terminal, without restating which lane a level writes to. A logger given its
 * own `writer` never reaches it, as with `installLogSink`. A tee that throws loses its own copy.
 */
export function teeLogLines(tee: LogSink): () => void {
  // A fresh wrapper per install, so the same function teed twice is two copies and two releases.
  const entry: LogSink = (line, level) => tee(line, level);
  logTees.add(entry);
  return () => {
    logTees.delete(entry);
  };
}

/** The process's streams, or the `installLogSink` seam standing in for them. */
function streamWriter(line: string, level: LogLevel): void {
  const logSink = logSinks.current();
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
 * foot of this file is `structuredLogger()` evaluated when the module is. Measured on one adopter's
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
  // REFUSED, as `resolveLevel` refuses the same value from `structuredLogger({ level })`. It fell back
  // to `info` in silence, so `LOG_LEVEL=verbose` — or `DEBUG`, the spelling half the ecosystem
  // uses — gave an operator who asked for MORE lines fewer, and nothing said the variable was the
  // reason. This runs at module init, so the refusal is the first thing the process prints.
  if (isLogLevel(raw)) return raw;
  return refuse(
    `LOG_LEVEL=${renderCauseValue(raw)} is not a log level`,
    `set LOG_LEVEL=info (one of ${LOG_LEVELS.join(', ')}, lowercase), or unset LOG_LEVEL`,
  );
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
  if (isLogLevel(declared)) return declared;
  // `renderCauseValue`, never `JSON.stringify`: it raises on a bigint and on a cycle, and a level
  // that arrived from a config file can be either — the refusal must not be replaced by a
  // `TypeError` from building its own message. Built only HERE, on the refusal: `ctxOf` derives a
  // logger per request, and rendering a message nobody throws was most of what that cost.
  return refuse(
    `${renderCauseValue(declared)} is not a log level`,
    `pass one of ${LOG_LEVELS.join(', ')} to structuredLogger({ level })`,
  );
}

function isLogLevel(value: unknown): value is LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(value);
}

/** `X_INVARIANT`, as `assert` throws it — called only once the refusal is certain. */
function refuse(cause: string, fix: string): never {
  assert(false, cause, fix);
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

export function structuredLogger(options?: LoggerOptions): Logger {
  const level = options?.level === undefined ? envLevel() : resolveLevel(options.level);
  const bound = bind(options?.fields ?? {});
  return derive(level, bound, options?.clock ?? liveClock, options?.writer ?? defaultWriter);
}

/**
 * A logger's bound fields: the caller's own, kept, and their redaction at `generation`. Redacted
 * once when bound, and again only when `redactKeys()` has declared a new secret since — `defineEnv`
 * runs it at boot, after a module-scope `logger.child()` may already have bound that very key.
 */
interface Bound {
  readonly raw: LogFields;
  redacted: Readonly<Record<string, unknown>>;
  generation: number;
}

function bind(raw: LogFields): Bound {
  return { raw, redacted: redactFields(raw), generation: redactionGeneration() };
}

/** The redacted snapshot, re-walked from `raw` only if a key was declared secret since. */
function current(bound: Bound): Readonly<Record<string, unknown>> {
  const now = redactionGeneration();
  if (bound.generation !== now) {
    bound.redacted = redactFields(bound.raw);
    bound.generation = now;
  }
  return bound.redacted;
}

/**
 * The logger itself, past every screen: `level` is already one of `LOG_LEVELS` and `bound` is
 * already redacted. `child()` comes back through here and never through `structuredLogger`, so a
 * per-request child (`ctxOf`) neither re-validates a level it inherited nor re-walks the fields its
 * parent bound — only its own, once, when it binds them.
 */
function derive(level: LogLevel, bound: Bound, clock: Clock, writer: LogSink): Logger {
  const threshold = LEVEL_WEIGHT[level];

  function emit(lineLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[lineLevel] < threshold) return;
    const context = contextFields();
    const caller = {
      ...current(bound),
      ...(context === undefined ? undefined : redactFields(context)),
      ...(fields === undefined ? undefined : redactFields(fields)),
    };
    const line = {
      ts: timestamp(clock),
      level: lineLevel,
      msg: message,
      ...unreserved(caller),
    };
    writer(renderLine(line, lineLevel, message, line.ts), lineLevel);
    // `log.record`, after the streams, so a subscriber can never cost a line its stdout. The process
    // logger's population only: a logger given its own `writer` is a test's or a command's answer.
    if (writer === defaultWriter && subscribed('log.record')) {
      publishRecord(clock, lineLevel as Exclude<LogLevel, 'silent'>, message, caller);
    }
  }

  return {
    level,
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    fatal: (message, fields) => emit('fatal', message, fields),
    child: (fields) => {
      const parent = current(bound);
      const child: Bound = {
        raw: { ...bound.raw, ...fields },
        redacted: { ...parent, ...redactFields(fields) },
        generation: bound.generation,
      };
      return derive(level, child, clock, writer);
    },
    // A public door, so the level is screened again: a child cannot widen what the parent refused.
    withLevel: (next) => derive(resolveLevel(next), bound, clock, writer),
  };
}

/** The process-wide logger. Prefer `ctx.logger` inside a request — it carries the ids. */
export const logger: Logger = structuredLogger();
