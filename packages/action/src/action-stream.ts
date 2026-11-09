/**
 * A stream-declaring action's handler, drained. `handle` is an async generator: every yielded chunk
 * is parsed by `stream`, handed to the sink the HTTP stream projection opened (if any), and the
 * generator's RETURN value is the output — so `invoke`, MCP, `.job()` and `.as()` keep one contract.
 */

import type { Ctx } from '@ultimat3/core';
import { asyncContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import { ActionStreamInvalidError } from './errors-stream';
import { handlerOverrideOf } from './handler-override';

/** Where a draining handler hands its chunks: `http-stream.ts` opens one per streamed request. */
export interface ChunkSink {
  /** The wrapped declaration this sink is for — a nested action's chunks never reach it. */
  readonly owner: object;
  /** Called once, when the handler starts: the policy has passed by then. */
  start(): void;
  push(chunk: unknown): void | Promise<void>;
}

const sinks = asyncContext<{ readonly sink: ChunkSink; claimed: boolean }>('an action stream');
/** Whether the handler being drained right now has a reader for its chunks. */
const reading = asyncContext<boolean>('an action stream reader');

/**
 * Inside a stream-declaring `handle`: `true` when a caller is reading the chunks as they are
 * yielded (a `text/event-stream` request), `false` when the call is drained to its output alone
 * (MCP, `.job()`, `.as()`, JSON). A handler whose chunks cost something — `llm()` gives up its
 * repair turn to stream — produces them only when they are read. Per declaration: a nested
 * action's handler reads `false` unless it is the one the stream was opened for.
 */
export function chunksRead(): boolean {
  return reading.get() === true;
}

/** Run `fn` with `sink` receiving the chunks of the first draining handler that `owner` names. */
export function withChunkSink<T>(sink: ChunkSink, fn: () => T): T {
  return sinks.run({ sink, claimed: false }, fn);
}

/**
 * Each draining copy → the declaration it wraps. Built once per `.named()` twin, so an override is
 * keyed by the declaration (`declarationOf`), never the copy, and reaches every twin at once.
 */
const DRAINED = new WeakMap<object, object>();

/** Whether `def`'s `handle` is the drain: the drain, not `invoke`, resolves its override. */
export const drainsItsHandler = (def: object): boolean => DRAINED.has(def);

/** The declaration an override is keyed by: the wrapped one for a draining copy, else `def`. */
export const declarationOf = (def: object): object => DRAINED.get(def) ?? def;

interface StreamingDef {
  readonly stream?: StandardSchemaV1;
  handle(args: { readonly input: unknown; readonly ctx: Ctx }): unknown;
}

/**
 * The declaration `invoke` runs: `def` unchanged without `stream`, else a copy whose `handle`
 * drains. Built per name, so an error names the action that was called.
 */
export function streamingDef<D extends StreamingDef>(def: D, name: () => string): D {
  const stream = def.stream;
  if (stream === undefined) return def;
  const wrapped: D = {
    ...def,
    // The override is resolved per call, never captured here: a test double installed after the
    // declaration (`overrideHandler`) is drained exactly as the declared generator would be.
    handle: (args: { readonly input: unknown; readonly ctx: Ctx }) =>
      drain(wrapped, stream, name(), (handlerOverrideOf(def) ?? def.handle.bind(def))(args)),
  };
  DRAINED.set(wrapped, def);
  return wrapped;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, undefined> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly next?: unknown; readonly [Symbol.asyncIterator]?: unknown };
  return (
    typeof candidate.next === 'function' && typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

async function drain(
  owner: object,
  stream: StandardSchemaV1,
  name: string,
  produced: unknown,
): Promise<unknown> {
  if (!isAsyncGenerator(produced)) {
    throw new ActionStreamInvalidError(
      name,
      'its handle is not an async generator (async *handle)',
    );
  }
  const open = sinks.get();
  // Claimed once: the first draining handler of THIS declaration owns the response stream.
  const sink = open !== undefined && !open.claimed && open.sink.owner === owner ? open.sink : null;
  if (open !== undefined && sink !== null) open.claimed = true;
  sink?.start();
  // Every resume of the generator runs inside this scope, so its body reads `chunksRead()`.
  return reading.run(sink !== null, () => pump(produced, stream, name, sink));
}

async function pump(
  produced: AsyncGenerator<unknown, unknown, undefined>,
  stream: StandardSchemaV1,
  name: string,
  sink: ChunkSink | null,
): Promise<unknown> {
  try {
    for (;;) {
      const step = await produced.next();
      if (step.done === true) return step.value;
      const parsed = await validateAsync(stream, step.value);
      if (parsed.issues !== undefined) {
        const issues = formatIssues(parsed.issues).join('; ');
        throw new ActionStreamInvalidError(
          name,
          `yielded a chunk its stream schema refuses: ${issues}`,
        );
      }
      await sink?.push(parsed.value);
    }
  } finally {
    // A throw above (a refused chunk, a sink that failed) ends the generator, so its own
    // `finally` runs and nothing it holds is left open.
    await produced.return(undefined);
  }
}
