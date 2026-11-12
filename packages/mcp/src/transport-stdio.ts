// stdio transport for `x mcp serve` — newline-delimited JSON-RPC on stdin/stdout.
//
// A local agent (Claude Code, an editor) launches the process and speaks over the pipe, so
// there is no token to resolve: the caller already has the developer's shell. The caller is
// therefore constructed once from the local developer identity the CLI supplies, and its
// scopes are whatever that developer is entitled to — no network boundary to defend.
//
// stdout is the WIRE. Anything logged there corrupts the protocol, so diagnostics go to
// stderr and this file never calls `console.log`.

import { finiteCount } from '@ultimat3/core';
import { McpBodyTooLargeError } from './errors-transport';
import type { McpCaller } from './registry';
import type { McpServer } from './server';
import type { StdioFrame } from './stdio-lines';
import { lineSplitter } from './stdio-lines';
import type { JsonRpcId, JsonRpcRequest } from './wire';
import {
  errorResponse,
  INVALID_REQUEST,
  isJsonRpcRequest,
  isNotification,
  PARSE_ERROR,
  paramsOf,
  refusalMessage,
} from './wire';

/**
 * BYTES held for ONE message that has not ended yet. `transport-http.ts` caps the same wire at
 * 1 MiB with `readWithinLimit`, and two transports must not answer one question two ways: the peer
 * launched this process and is trusted, but a bug in it is not — a stream with no newline in it
 * grew this buffer until the process died, with no frame written for the request already in flight.
 * Counted on the raw chunk before decoding (`stdio-lines.ts`): characters let 3 MiB of CJK past.
 */
export const DEFAULT_STDIO_LINE_LIMIT = 1_048_576;

/**
 * Requests answered at once. Each line is dispatched without waiting for the one before it — a slow
 * `tools/call` held every later frame, `ping` included. Past this many a request waits in a queue
 * of `STDIO_MAX_QUEUED` while the reader goes on reading — a `notifications/cancelled` or a `ping`
 * for the calls holding the slots is still heard — and only a FULL queue stops the reader: the
 * pipe's own back-pressure, never an unbounded fan-out.
 */
export const STDIO_MAX_IN_FLIGHT = 16;

/** Requests read and waiting for a slot. A full queue parks the reader until one starts. */
export const STDIO_MAX_QUEUED = 64;

export interface StdioTransportInput {
  readonly server: McpServer;
  /** The local developer, already resolved by the CLI. Usually `kind: 'agent'`. */
  readonly caller: McpCaller;
  /** Defaults to `Bun.stdin.stream()`; overridable so a test can feed a fixed script. */
  readonly input?: ReadableStream<Uint8Array>;
  /** Defaults to writing `Bun.stdout`. */
  write?(chunk: string): Promise<void> | void;
  /** Bytes buffered for one unterminated message. Defaults to `DEFAULT_STDIO_LINE_LIMIT`. */
  readonly lineLimitBytes?: number | undefined;
}

/**
 * Serve until stdin closes and every call in flight has answered. Resolves when the peer
 * disconnects, which is the CLI's signal to exit 0 — a closed pipe is a normal shutdown.
 */
export async function serveStdio(config: StdioTransportInput): Promise<void> {
  const stream = config.input ?? Bun.stdin.stream();
  const write = config.write ?? defaultWrite;
  // Before a byte of stdin is read, because `bytes > NaN` is false for EVERY line: the cap would
  // not be a large one, it would be absent, and the buffer it bounds grows until the process dies.
  // `??` cannot screen it — `NaN` is not nullish. Floor of 1: a cap of 0 refuses every message
  // there is, which is a dead transport rather than a bound.
  const limit = finiteCount(
    'serveStdio',
    'lineLimitBytes',
    config.lineLimitBytes ?? DEFAULT_STDIO_LINE_LIMIT,
    1,
  );
  const lines = lineSplitter(limit);
  const wire = stdioDispatch(config.server, config.caller, write);

  for await (const chunk of stream) {
    for (const frame of lines.push(chunk)) await wire.take(frame, limit);
    wire.check();
  }
  for (const frame of lines.end()) await wire.take(frame, limit);
  await wire.drain();
}

/** Frames in, answers out: one task per request, one ordered writer, one abort per request id. */
function stdioDispatch(
  server: McpServer,
  caller: McpCaller,
  write: (chunk: string) => Promise<void> | void,
) {
  const inFlight = new Set<Promise<void>>();
  const cancels = new Map<string, AbortController>();
  // Read, not started: a cancel takes one out before it ever runs.
  const queued: JsonRpcRequest[] = [];
  // Woken whenever a slot frees: the reader parked on a full queue, and `drain`.
  let freed: () => void = () => undefined;
  const slotFreed = (): Promise<void> =>
    new Promise((resolve) => {
      freed = resolve;
    });
  let failure: { readonly thrown: unknown } | undefined;
  // Every frame goes through ONE chain, so two answers finishing together never interleave bytes.
  let tail: Promise<void> = Promise.resolve();
  const send = (frame: unknown): Promise<void> => {
    tail = tail.then(() => write(`${JSON.stringify(frame)}\n`));
    return tail;
  };
  const check = (): void => {
    if (failure !== undefined) throw failure.thrown;
  };

  const run = (body: JsonRpcRequest): void => {
    const key = body.id === undefined ? undefined : idKey(body.id);
    const controller = new AbortController();
    if (key !== undefined) cancels.set(key, controller);
    const task = (async () => {
      const response = await server.handle(body, caller, { transport: 'stdio' }, controller.signal);
      // `null` is a notification: nothing at all, or the peer sees a phantom reply. A cancelled
      // request gets no answer either — the spec's receiver rule; the peer has stopped waiting.
      if (response === null || controller.signal.aborted) return;
      await send(response);
    })()
      .catch((thrown: unknown) => {
        failure ??= { thrown };
      })
      .finally(() => {
        if (key !== undefined && cancels.get(key) === controller) cancels.delete(key);
        inFlight.delete(task);
        pump();
        freed();
      });
    inFlight.add(task);
  };
  const pump = (): void => {
    while (inFlight.size < STDIO_MAX_IN_FLIGHT && queued.length > 0) {
      run(queued.shift() as JsonRpcRequest);
    }
  };

  return {
    check,
    async take(frame: StdioFrame, limit: number): Promise<void> {
      check();
      if (frame.kind === 'over-limit') return send(overLimit(limit));
      const trimmed = frame.text.trim();
      if (trimmed.length === 0) return;
      let body: unknown;
      try {
        body = JSON.parse(trimmed);
      } catch {
        return send(errorResponse(null, PARSE_ERROR, 'invalid JSON line'));
      }
      const cancelled = cancelledId(body);
      if (cancelled !== undefined) {
        const key = idKey(cancelled);
        // Still queued: it never runs, and — cancelled — never answers.
        const waiting = queued.findIndex((one) => one.id !== undefined && idKey(one.id) === key);
        if (waiting >= 0) queued.splice(waiting, 1);
        // The tool sees `signal.aborted`; its answer, if it still returns one, is dropped below.
        cancels.get(key)?.abort();
        return;
      }
      // A ping is the peer asking whether the wire is alive: answered at once, never queued.
      if (isJsonRpcRequest(body) && body.method === 'ping') return run(body);
      // The envelope check is the server's: a non-request is handed on and refused there.
      queued.push(body as JsonRpcRequest);
      pump();
      while (queued.length >= STDIO_MAX_QUEUED) await slotFreed();
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0 || queued.length > 0) await slotFreed();
      await tail;
      check();
    },
  };
}

/** A string `"7"` and a number `7` are two ids by JSON-RPC, so they are two keys here. */
const idKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

/** The `requestId` a `notifications/cancelled` names, or `undefined` for any other message. */
function cancelledId(body: unknown): JsonRpcId | undefined {
  if (!isJsonRpcRequest(body) || !isNotification(body)) return undefined;
  if (body.method !== 'notifications/cancelled') return undefined;
  const requestId = paramsOf(body)?.['requestId'];
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

/**
 * Answered once per over-long message, and the `fix` is what the peer has to change. The same
 * `X_MCP_BODY_TOO_LARGE` the HTTP transport's 413 carries: one condition, one code, on both wires.
 */
function overLimit(limit: number): ReturnType<typeof errorResponse> {
  const refusal = new McpBodyTooLargeError({ transport: 'stdio', limit });
  // `message` carries the fix as the HTTP 413's does: a peer reading nothing but `message` still
  // learns the next move. The two transports' words differ — a line is not a body — and the SHAPE
  // is the one `refusalMessage` owns.
  return errorResponse(null, INVALID_REQUEST, refusalMessage(refusal), {
    code: refusal.code,
    cause: refusal.cause,
    fix: refusal.fix,
    docs: refusal.docs,
    limit,
  });
}

/**
 * `Bun.stdout.write` is ASYNCHRONOUS when fd 1 is a pipe — which it always is here, because the
 * peer LAUNCHED this process — and it answers the count it accepted, never the count it wrote.
 * Dropping that promise made every `await write(...)` above await nothing: the CLI's exit ran with
 * the tail still queued and the peer lost it. Measured: a 4,000,236-byte frame arrived as 1,388,672
 * bytes. Awaiting it is also the back-pressure this loop otherwise has none of.
 */
async function defaultWrite(chunk: string): Promise<void> {
  await Bun.stdout.write(chunk);
}
