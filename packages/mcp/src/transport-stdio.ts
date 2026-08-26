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
import type { McpCaller } from './registry';
import type { McpServer } from './server';
import { errorResponse, INVALID_REQUEST, PARSE_ERROR } from './wire';

/**
 * Characters held for ONE message that has not ended yet. `transport-http.ts` caps the same wire at
 * 1 MiB with `readWithinLimit`, and two transports must not answer one question two ways: the peer
 * launched this process and is trusted, but a bug in it is not — a stream with no newline in it
 * grew this buffer until the process died, with no frame written for the request already in flight.
 * Characters rather than bytes because characters are what is retained here; one is never less than
 * one byte on the wire, so the cap bounds both.
 */
export const DEFAULT_STDIO_LINE_LIMIT = 1_048_576;

export interface StdioTransportInput {
  readonly server: McpServer;
  /** The local developer, already resolved by the CLI. Usually `kind: 'agent'`. */
  readonly caller: McpCaller;
  /** Defaults to `Bun.stdin.stream()`; overridable so a test can feed a fixed script. */
  readonly input?: ReadableStream<Uint8Array>;
  /** Defaults to writing `Bun.stdout`. */
  write?(chunk: string): Promise<void> | void;
  /** Characters buffered for one unterminated message. Defaults to `DEFAULT_STDIO_LINE_LIMIT`. */
  readonly lineLimitBytes?: number | undefined;
}

/**
 * Serve until stdin closes. Resolves when the peer disconnects, which is the CLI's signal
 * to exit 0 — a closed pipe is a normal shutdown, not an error.
 */
export async function serveStdio(config: StdioTransportInput): Promise<void> {
  const stream = config.input ?? Bun.stdin.stream();
  const write = config.write ?? defaultWrite;
  // Before a byte of stdin is read, because `line.length > NaN` is false for EVERY line: the cap
  // would not be a large one, it would be absent, and the buffer it bounds grows until the process
  // dies. `??` cannot screen it — `NaN` is not nullish. Floor of 1: a cap of 0 refuses every
  // message there is, which is a dead transport rather than a bound.
  const limit = finiteCount(
    'serveStdio',
    'lineLimitBytes',
    config.lineLimitBytes ?? DEFAULT_STDIO_LINE_LIMIT,
    1,
  );
  const decoder = new TextDecoder();
  let buffer = '';
  // The rest of an over-long message is dropped, not parsed: whatever follows it on the same line
  // is the tail of a message this transport refused, never a message of its own.
  let discarding = false;

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    if (discarding) {
      const end = buffer.indexOf('\n');
      if (end === -1) {
        buffer = '';
        continue;
      }
      buffer = buffer.slice(end + 1);
      discarding = false;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // Checked before the parse, never inside it: a line already over the cap costs a `JSON.parse`
      // over the whole of it, which is the work the cap exists to refuse.
      if (line.length > limit) await write(`${JSON.stringify(overLimit(limit))}\n`);
      else await handleLine(config.server, config.caller, line, write);
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > limit) {
      await write(`${JSON.stringify(overLimit(limit))}\n`);
      buffer = '';
      discarding = true;
    }
  }
  // A trailing message with no newline is still a message — unless it is the tail being dropped.
  if (!discarding && buffer.trim().length > 0) {
    if (buffer.length > limit) await write(`${JSON.stringify(overLimit(limit))}\n`);
    else await handleLine(config.server, config.caller, buffer, write);
  }
}

/** Answered once per over-long message, and the `fix` is what the peer has to change. */
function overLimit(limit: number): ReturnType<typeof errorResponse> {
  return errorResponse(
    null,
    INVALID_REQUEST,
    `a single message exceeded ${limit} characters and was dropped`,
    {
      limit,
      fix: `send one JSON-RPC message per line, each under ${limit} characters — split a large tool result into paged calls`,
    },
  );
}

async function handleLine(
  server: McpServer,
  caller: McpCaller,
  line: string,
  write: (chunk: string) => Promise<void> | void,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch {
    await write(`${JSON.stringify(errorResponse(null, PARSE_ERROR, 'invalid JSON line'))}\n`);
    return;
  }

  const response = await server.handle(body, caller);
  // `null` means notification: emit nothing at all, or the peer sees a phantom reply.
  if (response === null) return;
  await write(`${JSON.stringify(response)}\n`);
}

function defaultWrite(chunk: string): void {
  Bun.stdout.write(chunk);
}
