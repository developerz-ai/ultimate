// What a FAILED test carries beside its own message: under e2e, the spawned app's last log lines.
// The app's log was shown only when it failed to boot, so a live-path bug — a fanout that dropped a
// change, a 500 behind a page — failed with a browser assertion and nothing from the server.
// Held on `globalThis` under one `Symbol.for` key: the e2e preload and a test file may each hold
// their own copy of this module, as `e2e-browser-handle.ts` already explains.

const KEY = Symbol.for('ultimate.test.failure-context');

/** Bounded twice: a log line can be a megabyte of JSON, and an app can talk for minutes. */
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;

/** Install (or with `undefined`, remove) the source of a failure's context. */
export function setFailureContext(source: (() => string) | undefined): void {
  if (source === undefined) Reflect.deleteProperty(globalThis, KEY);
  else Object.defineProperty(globalThis, KEY, { value: source, configurable: true });
}

/** The last `TAIL_LINES` lines of `log`, and never more than `TAIL_CHARS` of them. */
export function appLogTail(log: string): string {
  const lines = log.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length <= TAIL_CHARS ? lines : lines.slice(-TAIL_CHARS);
}

/**
 * `error` with the app's log tail appended to its message, when a source is installed and has
 * anything to say. Only an `Error`'s message is extended — that is what the runner prints under
 * the failing test — and a thrown non-Error is handed back exactly as it was.
 */
export function withFailureContext(error: unknown): unknown {
  const source = Reflect.get(globalThis, KEY) as (() => string) | undefined;
  if (source === undefined || !(error instanceof Error)) return error;
  const tail = appLogTail(source());
  if (tail === '') return error;
  const count = tail.split('\n').length;
  Object.defineProperty(error, 'message', {
    value: `${error.message}\n\n── the e2e app logged, last ${String(count)} line(s): ──\n${tail}`,
    configurable: true,
    writable: true,
  });
  return error;
}
