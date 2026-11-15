// The inbound MIME parser on its own: the shapes real clients write (alternative inside mixed,
// RFC 2047 subjects, RFC 2231 filenames, quoted-printable, groups), and that every bound and
// every malformation is a coded refusal — never a bare throw, never a partial message.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { DEFAULT_MIME_LIMITS, parseMime } from './mime-parse';
import { parseAddressList } from './mime-parse-address';

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
