// stdio transport for `x mcp serve` — newline-delimited JSON-RPC on stdin/stdout.
//
// A local agent (Claude Code, an editor) launches the process and speaks over the pipe, so
// there is no token to resolve: the caller already has the developer's shell. The caller is
// therefore constructed once from the local developer identity the CLI supplies, and its
// scopes are whatever that developer is entitled to — no network boundary to defend.
//
// stdout is the WIRE. Anything logged there corrupts the protocol, so diagnostics go to
// stderr and this file never calls `console.log`.

import type { McpCaller } from './registry.ts';
import type { McpServer } from './server.ts';
import { errorResponse, PARSE_ERROR } from './wire.ts';

export interface StdioTransportInput {
  readonly server: McpServer;
  /** The local developer, already resolved by the CLI. Usually `kind: 'agent'`. */
  readonly caller: McpCaller;
  /** Defaults to `Bun.stdin.stream()`; overridable so a test can feed a fixed script. */
  readonly input?: ReadableStream<Uint8Array>;
  /** Defaults to writing `Bun.stdout`. */
  write?(chunk: string): Promise<void> | void;
}

/**
 * Serve until stdin closes. Resolves when the peer disconnects, which is the CLI's signal
 * to exit 0 — a closed pipe is a normal shutdown, not an error.
 */
export async function serveStdio(config: StdioTransportInput): Promise<void> {
  const stream = config.input ?? Bun.stdin.stream();
  const write = config.write ?? defaultWrite;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await handleLine(config.server, config.caller, line, write);
      newline = buffer.indexOf('\n');
    }
  }
  // A trailing message with no newline is still a message.
  if (buffer.trim().length > 0) {
    await handleLine(config.server, config.caller, buffer, write);
  }
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
