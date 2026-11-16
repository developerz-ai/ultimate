// What a header may carry: injection refused, and a non-ASCII display name or mailbox encoded the
// way RFC 2047 and RFC 6531 say. Split from mime.test.ts, which keeps the message builder.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type MailMessage, messageHeaders } from './driver';
import { buildMimeMessage, hasNonAsciiAddrSpec, type MimeOptions } from './mime';

function baseMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    mailId: 'welcome',
    to: ['ada@example.test'],
    subject: 'Welcome aboard',
    html: '<p>Hello</p>',
    text: 'Hello',
    locale: 'en',
    tz: 'UTC',
    ...overrides,
  };
}

function baseOptions(overrides: Partial<MimeOptions> = {}): MimeOptions {
  return {
    from: 'Postly <no-reply@postly.test>',
    messageId: '<abc123@postly.test>',
    date: new Date('2026-08-09T12:34:56Z'),
    boundary: 'BOUNDARY_abc123',
    ...overrides,
  };
}

describe('header injection', () => {
  const codeOf = (value: unknown): string =>
    isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

  const thrown = (fn: () => unknown): unknown => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error;
    }
  };

  test('a CR or LF in the subject is refused, ASCII or not', () => {
    const injected = 'Welcome\r\nBcc: attacker@evil.test';

    expect(
      codeOf(thrown(() => buildMimeMessage(baseMessage({ subject: injected }), baseOptions()))),
    ).toBe('X_MAIL_HEADER_INVALID');
    // Encoding runs after the check, so a non-ASCII subject cannot hide a break inside an
    // encoded word and take a different path from the same input in ASCII.
    expect(
      codeOf(
        thrown(() => buildMimeMessage(baseMessage({ subject: `café${injected}` }), baseOptions())),
      ),
    ).toBe('X_MAIL_HEADER_INVALID');
  });

  test('a CR or LF in a recipient or in the from address is refused', () => {
    expect(
      codeOf(
        thrown(() =>
          buildMimeMessage(
            baseMessage({ to: ['ada@example.test\r\nBcc: x@evil.test'] }),
            baseOptions(),
          ),
        ),
      ),
    ).toBe('X_MAIL_HEADER_INVALID');
    expect(
      codeOf(
        thrown(() =>
          buildMimeMessage(baseMessage(), baseOptions({ from: 'a@b.test\nSubject: forged' })),
        ),
      ),
    ).toBe('X_MAIL_HEADER_INVALID');
  });

  // `replyTo` and `unsubscribeUrl` reach `header()` through the `messageHeaders()` loop, not
  // through a named call — the loop a future edit is most likely to hoist above the CR/LF gate
  // because computed-by-the-framework data looks trustworthy. It is not: both values are the
  // caller's, and `Reply-To` / `List-Unsubscribe` inject headers exactly like `Subject` does.
  test('a CR or LF in replyTo is refused, even though it arrives as a computed header', () => {
    expect(
      codeOf(
        thrown(() =>
          buildMimeMessage(
            baseMessage({ replyTo: 'support@postly.test\r\nBcc: x@evil.test' }),
            baseOptions(),
          ),
        ),
      ),
    ).toBe('X_MAIL_HEADER_INVALID');
  });

  test('a CR or LF in unsubscribeUrl is refused too', () => {
    const message = baseMessage({
      unsubscribeUrl: 'https://postly.test/u/abc\r\nBcc: x@evil.test',
    });

    // It reaches two headers (`List-Unsubscribe` and `List-Unsubscribe-Post`); the first one to
    // see it refuses, and the name in the error is whichever that is.
    expect(Object.keys(messageHeaders(message))).toContain('List-Unsubscribe');
    expect(codeOf(thrown(() => buildMimeMessage(message, baseOptions())))).toBe(
      'X_MAIL_HEADER_INVALID',
    );
  });

  test('a break in the body is fine — only headers can be injected', () => {
    const message = baseMessage({ text: 'line one\r\nline two', html: '<p>a</p>\n<p>b</p>' });

    expect(buildMimeMessage(message, baseOptions())).toContain('line one');
  });
});

/**
 * `Subject` has always been RFC 2047 encoded and the address headers were not, so a message whose
 * subject was safely 7-bit put `José Muñoz` on the wire as raw UTF-8 — an 8-bit header no
 * `smtp-protocol.ts` negotiation covers, because SMTPUTF8 is never offered. Only the display
 * PHRASE is encoded: encoding the whole list would base64 the commas and the angle brackets that
 * make it an address list at all.
 */
describe('a non-ASCII display name in an address header', () => {
  function headerLine(built: string, name: string): string {
    const block = built.slice(0, built.indexOf('\r\n\r\n'));
    const unfolded = block.split(`${'\r\n'} `).join(' ');
    return unfolded.split('\r\n').find((line) => line.startsWith(`${name}: `)) ?? '';
  }

  function isSevenBit(line: string): boolean {
    for (let index = 0; index < line.length; index += 1) {
      if (line.charCodeAt(index) > 0x7f) return false;
    }
    return true;
  }

  test('the To line is 7-bit and the addr-spec is verbatim', () => {
    const built = buildMimeMessage(
      baseMessage({ to: ['José Muñoz <jose@x.test>', 'ada@example.test'] }),
      baseOptions(),
    );
    const line = headerLine(built, 'To');

    expect(isSevenBit(line)).toBe(true);
    expect(line).toContain('=?UTF-8?B?');
    expect(line).toContain('<jose@x.test>');
    // The list separator and the second address survive as themselves.
    expect(line.endsWith(', ada@example.test')).toBe(true);
  });

  test('From and Cc are encoded the same way', () => {
    const built = buildMimeMessage(
      baseMessage({ cc: ['Åsa Ö <asa@x.test>'] }),
      baseOptions({ from: 'Pöstly <no-reply@postly.test>' }),
    );

    expect(isSevenBit(headerLine(built, 'From'))).toBe(true);
    expect(headerLine(built, 'From')).toContain('<no-reply@postly.test>');
    expect(isSevenBit(headerLine(built, 'Cc'))).toBe(true);
    expect(headerLine(built, 'Cc')).toContain('<asa@x.test>');
  });

  test('an ASCII address list is byte-identical to the unencoded form', () => {
    const built = buildMimeMessage(
      baseMessage({ to: ['Jane Doe <jane@x.test>', 'ada@example.test'], cc: ['lin@example.test'] }),
      baseOptions(),
    );

    expect(built).toContain('From: Postly <no-reply@postly.test>\r\n');
    expect(built).toContain('To: Jane Doe <jane@x.test>, ada@example.test\r\n');
    expect(built).toContain('Cc: lin@example.test\r\n');
  });

  test('a CRLF in a display name is still refused, never hidden inside an encoded word', () => {
    let code = 'no error thrown';
    try {
      buildMimeMessage(
        baseMessage({ to: ['Jösé\r\nBcc: x@evil.test <jose@x.test>'] }),
        baseOptions(),
      );
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_MAIL_HEADER_INVALID');
  });
});
describe('a non-ASCII mailbox', () => {
  // RFC 2047 encoded words are legal in a display PHRASE and nowhere else, so there is no encoding
  // `encodeAddressPhrase` could apply to the addr-spec — and SMTPUTF8 (RFC 6531), which is what
  // would make a raw UTF-8 mailbox legal, is negotiated by nothing in this package. So the message
  // gate refuses it, at the same place the CR/LF check runs, rather than putting 8-bit octets in a
  // `To:` header and the envelope beside it.
  test('is refused by the header gate, in every address list', () => {
    const hostile = 'josé@exämple.test';
    expect(() => buildMimeMessage(baseMessage({ to: [hostile] }), baseOptions())).toThrow(
      'X_MAIL_HEADER_INVALID',
    );
    expect(() => buildMimeMessage(baseMessage({ cc: [hostile] }), baseOptions())).toThrow(
      'X_MAIL_HEADER_INVALID',
    );
    expect(() => buildMimeMessage(baseMessage(), baseOptions({ from: hostile }))).toThrow(
      'X_MAIL_HEADER_INVALID',
    );
  });

  test('while a non-ASCII display name over an ASCII mailbox still encodes', () => {
    const built = buildMimeMessage(
      baseMessage({ to: ['José Muñoz <jose@example.test>'] }),
      baseOptions(),
    );
    expect(built).toContain('=?UTF-8?B?');
    expect(built).toContain('<jose@example.test>');
  });

  test('hasNonAsciiAddrSpec reads the mailbox and never the phrase', () => {
    expect(hasNonAsciiAddrSpec('José Muñoz <jose@example.test>')).toBe(false);
    expect(hasNonAsciiAddrSpec('josé@exämple.test')).toBe(true);
    expect(hasNonAsciiAddrSpec('Ada <josé@exämple.test>')).toBe(true);
    expect(hasNonAsciiAddrSpec('ada@example.test')).toBe(false);
  });
});
