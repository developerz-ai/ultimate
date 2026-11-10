// The pipe's framing, against a hand-fed stream: a message split across reads, two in one read, a
// multi-byte character straddling a read, and the close. The real browser run is
// `e2e/cdp-browser.e2e.test.ts`, whose launch goes over this transport.

import { describe, expect, test } from 'bun:test';
import { cdpConnectOver } from './cdp-connection';
import { pipeTransport } from './cdp-pipe';

/** A stream the test pushes byte chunks into, and a record of every byte the transport wrote. */
function ends() {
  let push = (_chunk: Uint8Array): void => undefined;
  let finish = (): void => undefined;
  const read = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
      finish = () => controller.close();
    },
  });
  const written: Uint8Array[] = [];
  let ended = false;
  return {
    pipe: {
      read,
      write: (bytes: Uint8Array) => {
        written.push(bytes);
      },
      end: () => {
        ended = true;
      },
    },
    push,
    finish: () => finish(),
    written,
    ended: () => ended,
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('pipeTransport', () => {
  test('writes each message as its JSON text ended by one NUL', () => {
    const io = ends();
    const transport = pipeTransport(io.pipe);
    transport.listen({ message: () => undefined, closed: () => undefined });
    transport.send('{"id":1}');

    expect([...(io.written[0] ?? [])]).toEqual([...bytes('{"id":1}'), 0]);
  });

  test('reassembles split messages, separates joined ones, and keeps a split character whole', async () => {
    const io = ends();
    const seen: string[] = [];
    pipeTransport(io.pipe).listen({ message: (text) => seen.push(text), closed: () => undefined });

    const snowman = bytes('{"t":"☃"}'); // ☃ is three bytes; cut inside it
    const cut = snowman.indexOf(0xe2) + 1;
    io.push(snowman.subarray(0, cut));
    io.push(
      new Uint8Array([...snowman.subarray(cut), 0, ...bytes('{"a":1}'), 0, ...bytes('{"b"')]),
    );
    io.push(new Uint8Array([...bytes(':2}'), 0]));
    await settle();

    expect(seen).toEqual(['{"t":"☃"}', '{"a":1}', '{"b":2}']);
  });

  test('the browser closing its end settles every call in flight on the connection', async () => {
    const io = ends();
    const connection = cdpConnectOver(pipeTransport(io.pipe), 60_000);
    const call = connection.send('Browser.getVersion').catch((error: unknown) => error);
    io.finish();

    expect(await call).toBeUltimateError('X_CDP_CALL_FAILED');
  });

  test('a reply over the pipe resolves its own call', async () => {
    const io = ends();
    const connection = cdpConnectOver(pipeTransport(io.pipe), 1_000);
    const call = connection.send('Browser.getVersion');
    io.push(new Uint8Array([...bytes('{"id":1,"result":{"product":"Chrome"}}'), 0]));

    expect((await call).result).toEqual({ product: 'Chrome' });
  });

  test('close releases the write end once, and a send after it writes nothing', () => {
    const io = ends();
    const transport = pipeTransport(io.pipe);
    transport.listen({ message: () => undefined, closed: () => undefined });
    transport.close();
    transport.close();
    transport.send('{"id":2}');

    expect(io.ended()).toBe(true);
    expect(io.written).toEqual([]);
  });
});
