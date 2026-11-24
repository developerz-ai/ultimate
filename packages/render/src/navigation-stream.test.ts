// A soft visit read as it arrives: the shell answers at the server's first flush mark while a hole
// is still open, the rest comes back whole chunk by whole chunk however the bytes were split, a page
// with no mark is read whole, and a cancel reaches the request.
import { describe, expect, test } from 'bun:test';
import { drain, readShell } from './navigation-stream';
import { STREAM_FLUSH_MARK } from './stream-scripts';

const MARK = STREAM_FLUSH_MARK;

/** A body the test writes into, byte run by byte run, and whether the reader cancelled it. */
function body() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const seen = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return {
    stream,
    seen,
    write: (text: string) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

const SHELL = '<!doctype html><html><head><title>P</title></head><body><x-hole id="x:a">…</x-hole>';
const CHUNK_A = '<template data-x-hole="x:a"><p>rows</p></template><script>$X()</script>';
const CHUNK_B = '<template data-x-hole="x:b"><p>more</p></template><script>$X()</script>';

describe('readShell', () => {
  test('answers with the shell at the first mark, while a hole is still open', async () => {
    const page = body();
    page.write(SHELL.slice(0, 20));
    page.write(`${SHELL.slice(20)}${MARK}`);
    const head = await readShell(page.stream);

    expect(head.html).toBe(SHELL);
    expect(head.rest).not.toBeNull();
    page.close();
  });

  test('the rest comes back as whole chunks, however the bytes were split; the tail is dropped', async () => {
    const page = body();
    page.write(`${SHELL}${MARK}${CHUNK_A.slice(0, 9)}`);
    const head = await readShell(page.stream);
    const first = head.rest?.next();
    page.write(`${CHUNK_A.slice(9)}${MARK.slice(0, 5)}`);
    page.write(`${MARK.slice(5)}`);
    expect(await first).toBe(CHUNK_A);
    page.write(`<!---->${CHUNK_B}${MARK}</body></html>`);
    page.close();
    expect(await head.rest?.next()).toBe(`<!---->${CHUNK_B}`);
    expect(await head.rest?.next()).toBeNull();
  });

  test('several chunks that arrived together come back as one run', async () => {
    const page = body();
    page.write(`${SHELL}${MARK}${CHUNK_A}${MARK}${CHUNK_B}${MARK}</body></html>`);
    page.close();
    const head = await readShell(page.stream);
    if (head.rest === null) return expect.unreachable('a streamed page has a rest');

    expect(await drain(head.rest)).toBe(`${CHUNK_A}${MARK}${CHUNK_B}`);
  });

  test('a page with no mark is read whole, with no rest', async () => {
    const page = body();
    page.write('<!doctype html><title>Whole</title>');
    page.write('<p>all of it</p>');
    page.close();

    expect(await readShell(page.stream)).toEqual({
      html: '<!doctype html><title>Whole</title><p>all of it</p>',
      rest: null,
    });
  });

  test('a cancel reaches the request, and the rest ends', async () => {
    const page = body();
    page.write(`${SHELL}${MARK}`);
    const head = await readShell(page.stream);
    const waiting = head.rest?.next();
    head.rest?.cancel();

    expect(await waiting).toBeNull();
    expect(page.seen.cancelled).toBe(true);
  });
});
