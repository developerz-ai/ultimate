// The answer body of a remote MCP call, read as JSON or as SSE: only OUR id answers, notifications
// are listed by method, and the SSE reading is core's one frame reader (`takeFrames`), not a copy.

import { describe, expect, test } from 'bun:test';
import { readNotifications, readRpcAnswer } from './remote-wire';

const SSE = 'text/event-stream';
const frame = (body: unknown): string => `event: message\ndata: ${JSON.stringify(body)}\n\n`;

describe('readRpcAnswer', () => {
  test('a JSON answer is the envelope; anything else is no answer', () => {
    expect(readRpcAnswer('application/json', '{"id":1,"result":{}}', 1)).toEqual({
      id: 1,
      result: {},
    });
    expect(readRpcAnswer('application/json', 'not json', 1)).toBeUndefined();
  });

  test('an SSE answer skips interleaved requests and comments for the frame carrying our id', () => {
    const body = `: keep-alive\n\n${frame({ method: 'ping', id: 9 })}${frame({ id: 1, result: { ok: true } })}`;
    expect(readRpcAnswer(SSE, body, 1)).toEqual({ id: 1, result: { ok: true } });
    expect(readRpcAnswer(SSE, body, 2)).toBeUndefined();
  });

  test('the last frame needs no blank line after it, and CRLF frames read the same', () => {
    expect(readRpcAnswer(SSE, 'data: {"id":3,\r\ndata: "result":1}', 3)).toEqual({
      id: 3,
      result: 1,
    });
    expect(readRpcAnswer(`${SSE}; charset=utf-8`, 'data: {"id":4}\r\n\r\n', 4)).toEqual({ id: 4 });
  });
});

describe('readNotifications', () => {
  test('every notification method on an SSE answer, none on JSON', () => {
    const body = `${frame({ method: 'notifications/progress' })}${frame({ id: 1, method: 'x' })}${frame({ method: 'notifications/message' })}`;
    expect(readNotifications(SSE, body)).toEqual([
      'notifications/progress',
      'notifications/message',
    ]);
    expect(readNotifications('application/json', body)).toEqual([]);
  });

  test('the module splits no SSE of its own', async () => {
    const source = await Bun.file(new URL('./remote-wire.ts', import.meta.url)).text();
    expect(source).toContain("from '@ultimat3/core/internal/sse-frames'");
    expect(source).not.toContain("startsWith('data:')");
  });
});
