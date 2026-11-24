// A soft visit read as it arrives: the shell answers at the server's first flush mark while a hole
// is still open, the rest comes back whole chunk by whole chunk however the bytes were split, a page
// with no mark is read whole, and a cancel reaches the request.
import { describe, expect, test } from 'bun:test';
import { escapeHtml } from '@ultimat3/core';
import { escapeJsonContent, escapeRawTextContent } from './html';
import { drain, readShell } from './navigation-stream';
import { STREAM_FLUSH_MARK, STREAM_KEEPALIVE_CHUNK } from './stream-scripts';

const MARK = STREAM_FLUSH_MARK;
const KEEPALIVE = STREAM_KEEPALIVE_CHUNK;

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
    bytes: (run: Uint8Array) => controller?.enqueue(run),
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
    page.write(`${KEEPALIVE}${CHUNK_B}${MARK}</body></html>`);
    page.close();
    expect(await head.rest?.next()).toBe(CHUNK_B);
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

  test('a character split across reads survives, in the shell and in a chunk', async () => {
    const encoder = new TextEncoder();
    const shellText = SHELL.replace('…', 'café ✓');
    const shell = encoder.encode(`${shellText}${MARK}`);
    const chunk = encoder.encode(`<p>naïve 🙂</p>${MARK}`);
    /** The byte offset one byte into `char`'s encoding in `text`: a cut inside that character. */
    const inside = (text: string, char: string): number =>
      encoder.encode(text.slice(0, text.indexOf(char))).length + 1;
    // Every cut lands inside a multibyte character: `é` and `ï` are 2 bytes, `✓` 3, `🙂` 4.
    const page = body();
    const shellCuts = [inside(shellText, 'é'), inside(shellText, '✓'), shell.length];
    shellCuts.reduce((from, to) => {
      page.bytes(shell.slice(from, to));
      return to;
    }, 0);
    const head = await readShell(page.stream);
    expect(head.html).toBe(shellText);
    const next = head.rest?.next();
    const chunkText = '<p>naïve 🙂</p>';
    const chunkCuts = [inside(chunkText, 'ï'), inside(chunkText, '🙂'), chunk.length];
    chunkCuts.reduce((from, to) => {
      page.bytes(chunk.slice(from, to));
      return to;
    }, 0);
    expect(await next).toBe(chunkText);
    page.close();
  });

  test('a hole held open for long holds no keep-alive frames in memory', async () => {
    const page = body();
    page.write(`${SHELL}${MARK}`);
    const head = await readShell(page.stream);
    const next = head.rest?.next();
    // A keep-alive split across two reads is still dropped once it is whole.
    for (let i = 0; i < 1_000; i += 1) page.write(KEEPALIVE);
    page.write(KEEPALIVE.slice(0, 3));
    page.write(`${KEEPALIVE.slice(3)}${CHUNK_A}${MARK}`);
    expect(await next).toBe(CHUNK_A);
    page.close();
  });

  test('keep-alives between two chunks of one read never reach the page', async () => {
    const page = body();
    page.write(`${SHELL}${MARK}`);
    const head = await readShell(page.stream);
    page.write(`${CHUNK_A}${MARK}${KEEPALIVE}${KEEPALIVE}${CHUNK_B}${MARK}`);
    expect(await head.rest?.next()).toBe(`${CHUNK_A}${MARK}${CHUNK_B}`);
    page.close();
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

// The reader ends the shell at the first mark it sees. That is sound only while no data the page
// renders can spell one: text and attributes, script and style bodies, JSON blocks — every way a
// value reaches the markup is escaped, so only an author's own `innerHTML` could carry it.
test('no rendered value spells the flush mark, however it was escaped', () => {
  const hostile = `{"note":"${MARK}${KEEPALIVE}"}</script>${MARK}${KEEPALIVE}`;
  for (const escaped of [
    escapeHtml(hostile),
    escapeRawTextContent(hostile),
    escapeJsonContent(hostile),
  ]) {
    expect(escaped).not.toContain(MARK);
    expect(escaped).not.toContain(KEEPALIVE);
  }
});
