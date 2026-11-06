// Single responsibility: the failure-capture buffer. While a `FailureStore` is installed, every
// `invoke` and `runQuery` opens one buffer; the seams below it (`@ultimat3/entity`'s reads,
// `@ultimat3/flags`' evaluations) record into it; a 5xx HOLDS the buffer on the thrown value, and
// `reportError` releases it with the report's own fingerprint. With no store, nothing allocates.

import { asyncContext } from './async-context';
import { tryUseContext } from './context';
import { renderThrowable } from './error-render';
import { isUltimateError } from './errors';
import type { CapturedValue } from './failure-capture-mask';
import { captureValue } from './failure-capture-mask';
import { logger } from './logger';

export type FailurePrimitive = 'action' | 'query';

/** One row a repository answered while the failing call ran: sealed columns never, secrets masked. */
export interface FailureRead {
  readonly entity: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly masked: readonly string[];
}

/** The actor, without `facts`: an app's facts are never logged and are not stored here either. */
export interface FailureActor {
  readonly kind: string;
  readonly id: string;
  readonly orgId: string | null;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly permissions: readonly string[];
}

/** What a 5xx left behind before the report named its group. */
export interface HeldFailure {
  readonly primitive: FailurePrimitive;
  readonly name: string;
  /** Epoch ms of the failure, from the request's own clock: the instant a replay freezes. */
  readonly at: number;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly build: string | null;
  readonly input: unknown;
  readonly masked: readonly string[];
  readonly actor: FailureActor | null;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly reads: readonly FailureRead[];
  readonly truncated: boolean;
}

/** The stored bundle: what was held, plus the group the report put it in. */
export interface FailureBundle extends HeldFailure {
  readonly id: string;
  readonly fingerprint: string;
  readonly code: string;
  /** The report's own `scope.operation` — `POST /api/x` from HTTP — or `null` when it named none. */
  readonly operation: string | null;
}

/** Where bundles go. `@ultimat3/db`'s `postgresFailureStore()` is the one the boot installs. */
export interface FailureStore {
  save(bundle: FailureBundle): Promise<void>;
}

export interface FailureCaptureLimits {
  readonly perHour: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}

interface Buffer {
  readonly primitive: FailurePrimitive;
  readonly name: string;
  input: CapturedValue | undefined;
  readonly flags: Map<string, unknown>;
  readonly reads: FailureRead[];
  truncated: boolean;
}

export type FailureFact =
  | { readonly kind: 'read'; readonly entity: string; readonly row: unknown }
  | { readonly kind: 'flag'; readonly key: string; readonly value: unknown };

const buffers = asyncContext<Buffer>('failure capture');
let store: FailureStore | null = null;
let limits: FailureCaptureLimits = { perHour: 5, maxRows: 50, maxBytes: 64 * 1024 };
/** Held on the thrown value itself, so no request id has to survive the trip to the reporter. */
const held = new WeakMap<object, HeldFailure>();

/** Install the store (capture on) or `null` (off). Returns the previous one, for a harness. */
export function setFailureStore(
  next: FailureStore | null,
  options: Partial<FailureCaptureLimits> = {},
): FailureStore | null {
  const previous = store;
  store = next;
  limits = { ...limits, ...options };
  return previous;
}

export const failureCaptureLimits = (): FailureCaptureLimits => limits;

/** Whether a call in flight is being captured: a seam asks this before it builds anything. */
export const failureCaptureActive = (): boolean => buffers.get() !== undefined;

/** One fact into the buffer in flight. Off, this is one `undefined` check and nothing else. */
export function recordFailureFact(fact: FailureFact): void {
  const buffer = buffers.get();
  if (buffer === undefined) return;
  if (fact.kind === 'flag') {
    if (!buffer.flags.has(fact.key)) buffer.flags.set(fact.key, captureValue(fact.value).value);
    return;
  }
  if (buffer.reads.length >= limits.maxRows) {
    buffer.truncated = true;
    return;
  }
  const { value, masked } = captureValue(fact.row);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  buffer.reads.push({ entity: fact.entity, row: value as Record<string, unknown>, masked });
}

/** The parsed input, already masked by its schema. The first one wins: it is the outermost call's. */
export function recordFailureInput(input: unknown): void {
  const buffer = buffers.get();
  if (buffer !== undefined && buffer.input === undefined) buffer.input = captureValue(input);
}

const actorNow = (): FailureActor | null => {
  const actor = tryUseContext()?.actor;
  if (actor === undefined) return null;
  return {
    kind: actor.kind,
    id: actor.id,
    orgId: actor.orgId ?? null,
    roles: [...actor.roles],
    scopes: [...actor.scopes],
    permissions: [...actor.permissions],
  };
};

function holdOf(buffer: Buffer): HeldFailure {
  const ctx = tryUseContext();
  return {
    primitive: buffer.primitive,
    name: buffer.name,
    at: ctx === undefined ? 0 : ctx.now().getTime(),
    requestId: ctx?.requestId ?? null,
    traceId: ctx?.traceId ?? null,
    build: ctx?.buildId ?? null,
    input: buffer.input?.value ?? null,
    masked: buffer.input?.masked ?? [],
    actor: actorNow(),
    flags: Object.fromEntries(buffer.flags),
    reads: [...buffer.reads],
    truncated: buffer.truncated,
  };
}

/**
 * Run one `invoke` / `runQuery` under a buffer. No store, or a buffer already open (a call inside
 * a call: the OUTER one is the request), and `run` runs bare. A throw whose status is 5xx is held
 * on the thrown value; a 4xx is the caller's, and has a problem document instead.
 */
export async function withFailureCapture<T>(
  primitive: FailurePrimitive,
  name: string,
  statusOf: (code: string) => number,
  run: () => Promise<T>,
): Promise<T> {
  if (store === null || buffers.get() !== undefined) return run();
  const buffer: Buffer = {
    primitive,
    name,
    input: undefined,
    flags: new Map(),
    reads: [],
    truncated: false,
  };
  return buffers.run(buffer, async () => {
    try {
      return await run();
    } catch (error) {
      const code = isUltimateError(error) ? error.code : 'X_INTERNAL';
      if (typeof error === 'object' && error !== null && statusOf(code) >= 500) {
        held.set(error, holdOf(buffer));
      }
      throw error;
    }
  });
}

/** Read and forget what a thrown value holds — `reportError`'s half, in `failure-capture-flush.ts`. */
export function takeHeldFailure(error: unknown): HeldFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const found = held.get(error);
  if (found !== undefined) held.delete(error);
  return found;
}

export const installedFailureStore = (): FailureStore | null => store;

/** A store that refused is logged and never reaches the response that is already on its way. */
export function failureStoreRefused(failure: unknown): void {
  logger.warn('failure capture store refused a bundle', { error: renderThrowable(failure) });
}
