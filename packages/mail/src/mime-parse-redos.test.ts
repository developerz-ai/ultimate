// The parser's cost is linear in what a sender controls. Every input here was quadratic or worse
// before its fix (seconds to never, on one worker's event loop, lease heartbeat included); each is
// held to a bound far above linear time and far below what the superlinear shape took.

import { describe, expect, test } from 'bun:test';
import { parseMime } from './mime-parse';
import { parseAddressList } from './mime-parse-address';
import { decodeWords } from './mime-parse-headers';

/** Generous for a loaded CI runner; the quadratic shapes took 3–50 s at these sizes. */
const BOUND_MS = 750;

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('mime parse — linear in what the sender controls', () => {
  test('a quoted-printable body of 1 MB of spaces and no newline', () => {
    const message = `From: a@x.test\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${' '.repeat(1_048_576)}`;
    expect(timed(() => parseMime(ascii(message)))).toBeLessThan(BOUND_MS);
  });

  test('a 60 KB Q-encoded word of underscores in a Subject (under the 64 KiB header bound)', () => {
    const message = `From: a@x.test\r\nSubject: =?utf-8?Q?a${'_'.repeat(60_000)}a?=\r\n\r\nhi`;
    let subject: string | undefined;
    const ms = timed(() => {
      subject = parseMime(ascii(message)).headers.find((field) => field.name === 'Subject')?.value;
    });
    expect(ms).toBeLessThan(BOUND_MS);
    expect(subject?.length).toBe(60_002);
  });

  test('an address list of 20,000 "<>(" runs', () => {
    expect(timed(() => parseAddressList('<>('.repeat(20_000)))).toBeLessThan(BOUND_MS);
  });

  test('a group-name scan over 5,000 encoded words and no colon', () => {
    const value = `${'=?a?Q?b?='.repeat(5_000)} <x@y.test>`;
    expect(timed(() => parseAddressList(value))).toBeLessThan(BOUND_MS);
  });

  test('a comment opener followed by 20,000 escaped parentheses', () => {
    expect(timed(() => parseAddressList(`(${'\\('.repeat(20_000)}`))).toBeLessThan(BOUND_MS);
  });

  test('decodeWords over 50,000 unterminated word openers', () => {
    expect(timed(() => decodeWords('=?a?Q?'.repeat(50_000)))).toBeLessThan(BOUND_MS);
  });

  test('the angle form still reads, comment tail included', () => {
    expect(parseAddressList('Jane <jane@x.test> (work), <b@x.test>')).toEqual([
      { address: 'jane@x.test', name: 'Jane' },
      { address: 'b@x.test', name: undefined },
    ]);
    expect(parseAddressList('a <b> c')).toEqual([{ address: 'a <b> c', name: undefined }]);
  });
});
