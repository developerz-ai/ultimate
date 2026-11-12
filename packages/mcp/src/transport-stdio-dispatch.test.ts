// The stdio wire answers each request on its own: a slow `tools/call` never holds a later frame,
// `notifications/cancelled` aborts the call it names, at most `STDIO_MAX_IN_FLIGHT` run at once,
// and the line cap counts BYTES — never UTF-16 units. No timers: a "slow" tool yields microtasks.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import { STDIO_MAX_IN_FLIGHT, serveStdio } from './transport-stdio';

const caller: McpCaller = { actor: agentActor({ id: 'dev' }), scopes: new Set() };
const ARGS = { type: 'object' as const, properties: {}, additionalProperties: true };

/** Yields until `done()` or the bound runs out: a tool that is slow without a clock. */
async function yieldUntil(done: () => boolean, bound = 20_000): Promise<void> {
  for (let i = 0; i < bound && !done(); i += 1) await Promise.resolve();
}

const frame = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`;

const callTool = (id: number, name: string, args: Record<string, unknown> = {}): string =>
  frame(id, 'tools/call', { name, arguments: args });

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function serve(
  tools: readonly AnyMcpTool[],
  lines: readonly string[],
  lineLimitBytes?: number,
  written: Record<string, unknown>[] = [],
): Promise<Record<string, unknown>[]> {
  await serveStdio({
    server: mcpServer({ tools }),
    caller,
    input: streamOf(lines),
    ...(lineLimitBytes === undefined ? {} : { lineLimitBytes }),
    write: (chunk) => void written.push(JSON.parse(chunk) as Record<string, unknown>),
  });
  return written;
}

describe('one slow call never blocks the wire', () => {
  test('a ping sent after a slow tools/call is answered first', async () => {
    const written: Record<string, unknown>[] = [];
    const slow: AnyMcpTool = {
      name: 'slow',
      description: 'slow',
      inputSchema: ARGS,
      async handle() {
        // Held until the ping's answer is out — or, run in sequence, for the whole bound.
        await yieldUntil(() => written.some((response) => response['id'] === 2));
        return textResult('done');
      },
    };
    await serve([slow], [callTool(1, 'slow'), frame(2, 'ping')], undefined, written);
    expect(written.map((response) => response['id'])).toEqual([2, 1]);
  });

  test(`at most ${STDIO_MAX_IN_FLIGHT} calls run at once, and every one is answered`, async () => {
    let running = 0;
    let peak = 0;
    const held: AnyMcpTool = {
      name: 'held',
      description: 'held',
      inputSchema: ARGS,
      async handle() {
        running += 1;
        peak = Math.max(peak, running);
        await yieldUntil(() => false, 2_000);
        running -= 1;
        return textResult('ok');
      },
    };
    const count = STDIO_MAX_IN_FLIGHT * 2 + 3;
    const lines = Array.from({ length: count }, (_, i) => callTool(i + 1, 'held'));
    const written = await serve([held], lines);
    expect(written).toHaveLength(count);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(STDIO_MAX_IN_FLIGHT);
  });
});

describe('notifications/cancelled', () => {
  test("aborts the named call's signal, and the cancelled call writes no answer", async () => {
    let seen: AbortSignal | undefined;
    const waits: AnyMcpTool = {
      name: 'waits',
      description: 'waits',
      inputSchema: ARGS,
      async handle(_args, _caller, signal) {
        seen = signal;
        await yieldUntil(() => signal?.aborted === true);
        return textResult('finished anyway');
      },
    };
    const cancel = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'user hit stop' },
    })}\n`;
    const written = await serve([waits], [callTool(7, 'waits'), cancel, frame(8, 'ping')]);
    expect(seen?.aborted).toBe(true);
    // The spec's receiver behaviour: a cancelled request gets no response at all.
    expect(written.map((response) => response['id'])).toEqual([8]);
  });

  test(`is read at the ${STDIO_MAX_IN_FLIGHT}-call cap, and so is a ping`, async () => {
    // Every slot held by a call that ends only when cancelled: a reader parked at the cap would
    // never see the cancellation, and the first call — and the wire — would wait forever.
    const aborted: number[] = [];
    const waits: AnyMcpTool = {
      name: 'waits',
      description: 'waits',
      inputSchema: ARGS,
      async handle(args, _caller, signal) {
        await yieldUntil(() => signal?.aborted === true);
        if (signal?.aborted === true) aborted.push(Number(args['n']));
        return textResult('finished');
      },
    };
    const count = STDIO_MAX_IN_FLIGHT + 1;
    const calls = Array.from({ length: count }, (_, i) => callTool(i + 1, 'waits', { n: i + 1 }));
    const cancel = (id: number): string =>
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })}\n`;
    const cancels = Array.from({ length: count }, (_, i) => cancel(i + 1));
    const written = await serve([waits], [...calls, frame(99, 'ping'), ...cancels]);
    expect(aborted).toContain(1);
    // The ping is answered; every cancelled call writes nothing, the queued one included.
    expect(written.map((response) => response['id'])).toEqual([99]);
  });

  test('a cancellation naming no call in flight changes nothing', async () => {
    const cancel = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 99 },
    })}\n`;
    const written = await serve([], [cancel, frame(1, 'ping')]);
    expect(written.map((response) => response['id'])).toEqual([1]);
  });
});

describe('lineLimitBytes counts bytes on the wire', () => {
  const MIB = 1_048_576;
  // 400,000 characters — under the cap in UTF-16 units — and 1,200,000 bytes of UTF-8.
  const wide = callTool(1, 'echo', { note: '中'.repeat(400_000) });
  const echo: AnyMcpTool = {
    name: 'echo',
    description: 'echo',
    inputSchema: ARGS,
    async handle(args) {
      return textResult(String(args['note']).length.toString());
    },
  };

  test('a complete line of 400k CJK characters is refused at 1 MiB', async () => {
    expect(wide.length).toBeLessThan(MIB);
    const written = await serve([echo], [wide], MIB);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ error: { data: { code: 'X_MCP_BODY_TOO_LARGE' } } });
  });

  test('the same bytes with no newline yet are refused while buffering, not grown', async () => {
    const unterminated = wide.slice(0, -1);
    const written = await serve([echo], [unterminated, frame(2, 'ping')], MIB);
    // One refusal, the code the cap owns — and the ping, on the tail of the refused line, never runs.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ error: { data: { code: 'X_MCP_BODY_TOO_LARGE' } } });
  });

  test('a line of exactly the cap in bytes is still answered', async () => {
    const line = frame(3, 'ping');
    const bytes = new TextEncoder().encode(line).length - 1;
    const written = await serve([], [line], bytes);
    expect(written).toEqual([expect.objectContaining({ id: 3, result: {} })]);
  });
});
