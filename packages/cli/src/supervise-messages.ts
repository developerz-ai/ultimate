// The control messages between the production supervisor and its children, over `ipc` with
// `serialization: 'json'`. Every value is a string, a number or a boolean: JSON turns a `Date` into
// a string and a `Map` into `{}` silently, and a `BigInt` throws on send (measured on Bun 1.4.4).

/** Every message carries it, so a stray `process.send` from an app module is never read as one. */
export const PROCESS_MESSAGE_TYPE = 'x-proc';

export type DrainSignal = 'SIGTERM' | 'SIGINT' | 'SIGUSR2';

/** Child → supervisor. */
export type ChildMessage =
  /** Booted and bound: `metricsUrl` is its loopback scrape base; `budgetMs` its drain bound. */
  | {
      readonly type: typeof PROCESS_MESSAGE_TYPE;
      readonly event: 'ready';
      readonly metricsUrl: string;
      readonly budgetMs: number;
    }
  /** Its drain began; the supervisor's per-child budget starts HERE, not at its own send. */
  | {
      readonly type: typeof PROCESS_MESSAGE_TYPE;
      readonly event: 'draining';
      readonly budgetMs: number;
    }
  /** Leaving with `code`: the supervisor reads the exit, this is said first. */
  | { readonly type: typeof PROCESS_MESSAGE_TYPE; readonly event: 'gone'; readonly code: number }
  /** A refusal no restart can fix (`X_PROCESSES_UNSHARED_STATE`): stop restarting, exit 1. */
  | { readonly type: typeof PROCESS_MESSAGE_TYPE; readonly event: 'fatal'; readonly code: string };

/** Supervisor → child: drain as if `signal` had arrived. */
export interface DrainMessage {
  readonly type: typeof PROCESS_MESSAGE_TYPE;
  readonly event: 'drain';
  readonly signal: DrainSignal;
}

const SIGNALS: ReadonlySet<unknown> = new Set(['SIGTERM', 'SIGINT', 'SIGUSR2']);

const fieldsOf = (message: unknown): Record<string, unknown> | undefined =>
  typeof message === 'object' &&
  message !== null &&
  (message as Record<string, unknown>)['type'] === PROCESS_MESSAGE_TYPE
    ? (message as Record<string, unknown>)
    : undefined;

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A child's message, screened: anything else is `undefined` and ignored. */
export function readChildMessage(message: unknown): ChildMessage | undefined {
  const fields = fieldsOf(message);
  if (fields === undefined) return undefined;
  const { event } = fields;
  if (event === 'ready' && typeof fields['metricsUrl'] === 'string' && count(fields['budgetMs'])) {
    return {
      type: PROCESS_MESSAGE_TYPE,
      event,
      metricsUrl: fields['metricsUrl'],
      budgetMs: fields['budgetMs'],
    };
  }
  if (event === 'draining' && count(fields['budgetMs'])) {
    return { type: PROCESS_MESSAGE_TYPE, event, budgetMs: fields['budgetMs'] };
  }
  if (event === 'gone' && typeof fields['code'] === 'number') {
    return { type: PROCESS_MESSAGE_TYPE, event, code: fields['code'] };
  }
  if (event === 'fatal' && typeof fields['code'] === 'string') {
    return { type: PROCESS_MESSAGE_TYPE, event, code: fields['code'] };
  }
  return undefined;
}

export function readDrainMessage(message: unknown): DrainMessage | undefined {
  const fields = fieldsOf(message);
  if (fields?.['event'] !== 'drain' || !SIGNALS.has(fields['signal'])) return undefined;
  return { type: PROCESS_MESSAGE_TYPE, event: 'drain', signal: fields['signal'] as DrainSignal };
}

export const drainMessage = (signal: DrainSignal): DrainMessage => ({
  type: PROCESS_MESSAGE_TYPE,
  event: 'drain',
  signal,
});
