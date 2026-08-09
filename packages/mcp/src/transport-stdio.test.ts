// NDJSON on stdin/stdout for `x mcp serve`. Drives `serveStdio` with a fed-in stream and a
// captured `write`, since stdout is the wire and must never be touched by the test itself.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { McpCaller } from './registry';
import { textResult } from './registry';
import { createMcpServer } from './server';
import { serveStdio } from './transport-stdio';

const caller: McpCaller = { actor: agentActor({ id: 'dev' }), scopes: new Set() };

const server = createMcpServer({
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return textResult('ok');
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
    const line = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"note":"café"}}\n';
    const bytes = new TextEncoder().encode(line);
    const mid = Math.floor(bytes.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const chunks: string[] = [];
    await serveStdio({ server, caller, input: stream, write: (c) => void chunks.push(c) });
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] ?? '').id).toBe(1);
  });
});
