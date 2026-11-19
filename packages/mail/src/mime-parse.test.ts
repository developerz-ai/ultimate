// The inbound MIME parser on its own: the shapes real clients write (alternative inside mixed,
// RFC 2047 subjects, RFC 2231 filenames, quoted-printable, groups), and that every bound and
// every malformation is a coded refusal — never a bare throw, never a partial message.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { DEFAULT_MIME_LIMITS, parseMime } from './mime-parse';
import { parseAddressList } from './mime-parse-address';
import { decodeWords, parseHeaderSection, parseStructured } from './mime-parse-headers';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text.replace(/\n/g, '\r\n'));

function refusal(run: () => unknown): UltimateError {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    return expect.unreachable(`expected a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('expected a coded refusal, the parse succeeded');
}

const NESTED = `From: =?UTF-8?Q?Jos=C3=A9_Mu=C3=B1oz?= <jose@sender.test>
To: support@app.test, "Doe, Jane" <jane@app.test>
Subject: =?UTF-8?B?w4dhIHZh?= =?UTF-8?B?IGJpZW4=?=
Content-Type: multipart/mixed; boundary="outer"

preamble is dropped
--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 soft=
 break
--inner
Content-Type: text/html; charset=utf-8

<p>Café</p>
--inner--
--outer
Content-Type: application/pdf
Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
epilogue is dropped
`;

describe('parseMime — what real clients write', () => {
  test('alternative inside mixed: text, html, one attachment, decoded headers', () => {
    const parsed = parseMime(bytes(NESTED));
    expect(parsed.text).toBe('Café soft break');
    expect(parsed.html).toBe('<p>Café</p>');
    expect(parsed.attachments).toHaveLength(1);
    const [pdf] = parsed.attachments;
    expect(pdf?.filename).toBe('résumé.pdf');
    expect(pdf?.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(pdf?.bytes)).toBe('%PDF-1.4\n');
    const subject = parsed.headers.find((field) => field.name === 'Subject')?.value;
    expect(subject).toBe('Ça va bien');
  });

  test('a single-part message with no Content-Type is text/plain', () => {
    const parsed = parseMime(bytes('From: a@x.test\nSubject: hi\n\nhello\n'));
    expect(parsed.text).toBe('hello\r\n');
    expect(parsed.attachments).toEqual([]);
  });

  test('a Content-ID and an inline disposition survive', () => {
    const parsed = parseMime(
      bytes(`From: a@x.test
Content-Type: multipart/related; boundary=b

--b
Content-Type: text/html

<img src="cid:logo">
--b
Content-Type: image/png
Content-ID: <logo>
Content-Disposition: inline
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--b--
`),
    );
    expect(parsed.attachments[0]).toMatchObject({ contentId: 'logo', inline: true });
  });

  test('address lists: quoted commas, groups, comments', () => {
    expect(
      parseAddressList('"Doe, Jane" <jane@x.test>, team: a@x.test, b@x.test;, c@x.test (Cee)'),
    ).toEqual([
      { address: 'jane@x.test', name: 'Doe, Jane' },
      { address: 'a@x.test', name: undefined },
      { address: 'b@x.test', name: undefined },
      { address: 'c@x.test', name: 'Cee' },
    ]);
  });
});

/** One header line, read the way `parseMime` reads it: raw for structure. */
const rawOf = (line: string): string => parseHeaderSection(line, 4096)[0]?.raw ?? '';

describe('parseMime — structure is read before RFC 2047 words are decoded (§5(3))', () => {
  test('a comment holding a colon is not a group', () => {
    // Comments are CFWS, legal anywhere in a mailbox: `via:` named a group and left `phone) …`.
    expect(parseAddressList('(sent via: phone) jane@x.test')).toEqual([
      { address: 'jane@x.test', name: 'sent via: phone' },
    ]);
    expect(parseAddressList('Ops Team (dept: 4) <ops@x.test>')).toEqual([
      { address: 'ops@x.test', name: 'Ops Team' },
    ]);
    // An escaped `)` and a nested comment do not end the comment early.
    expect(
      parseAddressList('(a \\) b: c) d@x.test, (x (y: z)) e@x.test').map((entry) => entry.address),
    ).toEqual(['d@x.test', 'e@x.test']);
    // A real group whose members carry comments is still a group.
    expect(parseAddressList('team (ops: eu): a@x.test (A: one), b@x.test;')).toEqual([
      { address: 'a@x.test', name: 'A: one' },
      { address: 'b@x.test', name: undefined },
    ]);
  });

  test('a decoded comma in a display name does not split the list', () => {
    expect(parseAddressList(rawOf('From: =?UTF-8?Q?M=C3=BCller=2C_Hans?= <hans@x.test>'))).toEqual([
      { address: 'hans@x.test', name: 'Müller, Hans' },
    ]);
  });

  test('a decoded colon in a display name is not a group', () => {
    expect(parseAddressList(rawOf('To: =?UTF-8?Q?Re=3A_Team?= <a@x.test>'))).toEqual([
      { address: 'a@x.test', name: 'Re: Team' },
    ]);
  });

  test('a decoded semicolon in an unquoted filename does not end the parameter', () => {
    const value = parseStructured(
      rawOf('Content-Disposition: attachment; filename==?UTF-8?Q?a;b.pdf?='),
    );
    expect(value.params.get('filename')).toBe('a;b.pdf');
  });

  test('an encoded word is one token: a literal comma inside it splits nothing', () => {
    expect(parseAddressList('=?UTF-8?Q?Doe,_Jane?= <j@x.test>, k@x.test')).toEqual([
      { address: 'j@x.test', name: 'Doe, Jane' },
      { address: 'k@x.test', name: undefined },
    ]);
  });

  test('a repeated plain parameter keeps its first value', () => {
    expect(
      parseStructured('attachment; filename="a.pdf"; filename="b.exe"').params.get('filename'),
    ).toBe('a.pdf');
  });

  test('a message: From with an encoded comma reads as one sender', () => {
    const parsed = parseMime(bytes('From: =?UTF-8?Q?M=C3=BCller=2C_Hans?= <hans@x.test>\n\nhi'));
    const from = parsed.headers.find((field) => field.name === 'From');
    expect(from?.value).toBe('Müller, Hans <hans@x.test>');
    expect(parseAddressList(from?.raw)).toHaveLength(1);
  });
});

describe('parseMime — RFC 2231 and RFC 2047 edges', () => {
  test('an extended filename* beats a plain filename; the two never glue', () => {
    const value = parseStructured(`attachment; filename="a.pdf"; filename*=utf-8''%C3%A4.pdf`);
    expect(value.params.get('filename')).toBe('ä.pdf');
  });

  test('only the extended pieces of a continuation are percent-decoded', () => {
    const value = parseStructured(`attachment; filename*0*=utf-8''%C3%A4; filename*1="100%25.pdf"`);
    expect(value.params.get('filename')).toBe('ä100%25.pdf');
  });

  test('adjacent encoded words of one charset join before decoding', () => {
    expect(decodeWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9?=')).toBe('café');
  });

  test('whitespace between encoded words is dropped, text around them kept', () => {
    expect(decodeWords('Re: =?UTF-8?Q?a?= =?ISO-8859-1?Q?=E9?= end')).toBe('Re: aé end');
  });
});

describe('parseMime — one bad attachment never loses the message', () => {
  const withPart = (part: string): string =>
    `From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nbody\n--b\n${part}\n--b--\n`;

  test.each([
    [
      'an unknown transfer encoding',
      'Content-Type: application/pdf\nContent-Transfer-Encoding: x-uuencode\n\nbegin 644 a',
    ],
    [
      'bad base64',
      'Content-Type: application/pdf\nContent-Transfer-Encoding: base64\n\n!!not base64!!',
    ],
  ])('%s is an attachment refusal, the body still reads', (_, part) => {
    const parsed = parseMime(bytes(withPart(part)));
    expect(parsed.text).toBe('body');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      contentType: 'application/pdf',
      refusal: 'X_MAIL_INBOUND_MALFORMED',
    });
    expect(parsed.attachments[0]?.bytes.byteLength).toBe(0);
  });

  test('an attachment with no Content-Type is application/octet-stream, never text/plain', () => {
    const parsed = parseMime(
      bytes(withPart('Content-Disposition: attachment; filename="notes"\n\nplain words')),
    );
    expect(parsed.attachments[0]?.contentType).toBe('application/octet-stream');
  });
});

describe('parseMime — refused, coded', () => {
  test.each([
    ['empty', ''],
    ['empty', 'not a header line\n\nbody'],
    ['header', 'From: a@x.test\nthis line has no colon\n\nbody'],
    ['boundary-missing', 'From: a@x.test\nContent-Type: multipart/mixed\n\n--x\n'],
    ['boundary-absent', 'From: a@x.test\nContent-Type: multipart/mixed; boundary=x\n\nno parts'],
    [
      'boundary-unclosed',
      'From: a@x.test\nContent-Type: multipart/mixed; boundary=x\n\n--x\n\nhi\n',
    ],
    [
      'boundary-invalid',
      `From: a@x.test\nContent-Type: multipart/mixed; boundary=${'b'.repeat(71)}\n\n`,
    ],
    ['transfer-encoding', 'From: a@x.test\nContent-Transfer-Encoding: x-uuencode\n\nbody'],
    ['base64', 'From: a@x.test\nContent-Transfer-Encoding: base64\n\n!!not base64!!'],
  ])('%s', (problem, message) => {
    const error = refusal(() => parseMime(bytes(message)));
    expect(error.code).toBe('X_MAIL_INBOUND_MALFORMED');
    expect(error.meta?.['problem']).toBe(problem);
  });

  const parts = (count: number): string =>
    `From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n${'--b\n\nx\n'.repeat(count)}--b--\n`;

  test.each([
    [
      'maxBytes',
      () => parseMime(bytes('From: a@x.test\n\nabc'), { ...DEFAULT_MIME_LIMITS, maxBytes: 8 }),
    ],
    ['maxParts', () => parseMime(bytes(parts(3)), { ...DEFAULT_MIME_LIMITS, maxParts: 3 })],
    [
      'maxDepth',
      () =>
        parseMime(
          bytes(
            'From: a@x.test\nContent-Type: multipart/mixed; boundary=a\n\n--a\nContent-Type: multipart/mixed; boundary=b\n\n--b\n\nx\n--b--\n--a--\n',
          ),
          { ...DEFAULT_MIME_LIMITS, maxDepth: 1 },
        ),
    ],
    [
      'maxAttachments',
      () =>
        parseMime(
          bytes(
            `From: a@x.test\nContent-Type: multipart/mixed; boundary=b\n\n${'--b\nContent-Type: image/png\n\nx\n'.repeat(3)}--b--\n`,
          ),
          { ...DEFAULT_MIME_LIMITS, maxAttachments: 2 },
        ),
    ],
    [
      'maxHeaderBytes',
      () =>
        parseMime(bytes(`From: a@x.test\nX-Pad: ${'p'.repeat(100)}\n\nx`), {
          ...DEFAULT_MIME_LIMITS,
          maxHeaderBytes: 64,
        }),
    ],
  ])('over %s', (limit, run) => {
    const error = refusal(run);
    expect(error.code).toBe('X_MAIL_INBOUND_TOO_LARGE');
    expect(error.meta?.['limit']).toBe(limit);
  });

  test('a part count at the bound is read', () => {
    expect(parseMime(bytes(parts(3)), { ...DEFAULT_MIME_LIMITS, maxParts: 4 }).text).toBe('xxx');
  });
});
