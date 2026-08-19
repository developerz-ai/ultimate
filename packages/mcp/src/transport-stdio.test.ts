// NDJSON on stdin/stdout for `x mcp serve`. Drives `serveStdio` with a fed-in stream and a
// captured `write`, since stdout is the wire and must never be touched by the test itself.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { McpCaller } from './registry';
import { textResult } from './registry';
import { createMcpServer } from './server';
import { DEFAULT_STDIO_LINE_LIMIT, serveStdio } from './transport-stdio';

const caller: McpCaller = { actor: agentActor({ id: 'dev' }), scopes: new Set() };

// `echo` returns its argument verbatim, so a byte that the transport mangled on its way in
// comes back out where an assertion can see it.
const server = createMcpServer({
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['note'],
        additionalProperties: false,
      },
      async handle(args) {
        return textResult(String(args['note']));
      },
    },
  ],
});

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function run(lines: readonly string[]): Promise<string[]> {
  const chunks: string[] = [];
  await serveStdio({
    server,
    caller,
    input: streamOf(lines),
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  return chunks;
}

describe('serveStdio', () => {
  test('one newline-delimited request produces one newline-terminated response', async () => {
    const chunks = await run(['{"jsonrpc":"2.0","id":1,"method":"initialize"}\n']);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(chunks[0] ?? '');
    expect(parsed.id).toBe(1);
    expect(parsed.result.serverInfo).toBeDefined();
  });

  test('two requests split across chunks are each answered once, in order', async () => {
    const chunks = await run([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,',
      '"method":"tools/list"}\n',
    ]);
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0] ?? '').id).toBe(1);
    expect(JSON.parse(chunks[1] ?? '').id).toBe(2);
  });

  test('a trailing message with no closing newline is still answered', async () => {
    const chunks = await run(['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] ?? '').id).toBe(1);
  });

  test('a blank line produces no response at all', async () => {
    const chunks = await run(['\n', '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n']);
    expect(chunks).toHaveLength(1);
  });

  test('an invalid JSON line answers a parse error, not a thrown exception', async () => {
    const chunks = await run(['not json at all\n']);
    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0] ?? '');
    expect(parsed.error.code).toBe(-32700);
  });

  test('a notification (no id) writes nothing — a phantom reply would corrupt the wire', async () => {
    const chunks = await run(['{"jsonrpc":"2.0","method":"notifications/ping"}\n']);
    expect(chunks).toHaveLength(0);
  });

  test('an empty stream resolves cleanly with no writes', async () => {
    const chunks = await run([]);
    expect(chunks).toHaveLength(0);
  });

  test('a multi-byte UTF-8 character split across chunk boundaries decodes correctly', async () => {
    const line = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { note: 'café' } },
    })}\n`;
    const bytes = new TextEncoder().encode(line);
    // Split BETWEEN the two bytes of `é` (0xC3 0xA9) — derived, because a fixed index (or the
    // midpoint) lands in the ASCII run and exercises no incremental decoding at all.
    const split = bytes.indexOf(0xc3) + 1;
    expect(bytes[split]).toBe(0xa9);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const chunks: string[] = [];
    await serveStdio({ server, caller, input: stream, write: (c) => void chunks.push(c) });

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0] ?? '');
    // The ECHOED value is the assertion. A decoder without `{ stream: true }` turns the two
    // halves into `caf` plus two U+FFFD replacement characters — still valid JSON, still
    // answering id 1 — so asserting on the envelope alone can never fail.
    expect(parsed.result.content[0].text).toBe('café');
  });
});

/**
 * `transport-http.ts` caps the same wire at 1 MiB with `readWithinLimit`; two transports must not
 * answer one question two ways. The peer launched this process, so it is trusted — a bug in it is
 * not, and a stream with no newline in it grew the buffer until the process died with no frame
 * written and no answer to the request that was already in flight.
 */
describe('a message with no newline in it', () => {
  const limit = 256;

  async function feed(lines: readonly string[]): Promise<string[]> {
    const chunks: string[] = [];
    await serveStdio({
      server,
      caller,
      input: streamOf(lines),
      lineLimitBytes: limit,
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    return chunks;
  }

  test('is refused once the cap is passed, with a coded frame rather than growth', async () => {
    const chunks = await feed(['x'.repeat(limit * 3)]);
    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0] ?? '');
    expect(parsed.error.code).toBe(-32600);
    expect(String(parsed.error.data.fix).length).toBeGreaterThan(0);
  });

  test('the session survives it: the next complete message is still answered', async () => {
    const chunks = await feed([
      'x'.repeat(limit * 3),
      'more overflow with no newline',
      '\n{"jsonrpc":"2.0","id":9,"method":"initialize"}\n',
    ]);
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0] ?? '').error.code).toBe(-32600);
    expect(JSON.parse(chunks[1] ?? '').id).toBe(9);
  });

  test('the discarded tail is never parsed as a message of its own', async () => {
    const chunks = await feed([
      `${'x'.repeat(limit * 2)}{"jsonrpc":"2.0","id":1,"method":"initialize"}\n`,
    ]);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] ?? '').error.code).toBe(-32600);
  });

  test('a message just under the cap is answered normally', async () => {
    const note = 'a'.repeat(20);
    const line = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { note } },
    })}\n`;
    expect(line.length).toBeLessThan(limit);
    const chunks = await feed([line]);
    expect(JSON.parse(chunks[0] ?? '').result.content[0].text).toBe(note);
  });

  test('the default cap matches the HTTP transport’s 1 MiB', () => {
    expect(DEFAULT_STDIO_LINE_LIMIT).toBe(1_048_576);
  });
});
