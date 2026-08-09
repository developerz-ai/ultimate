// Covers the RFC 5322 / MIME builder: header order and folding, RFC 2047 subject encoding,
// quoted-printable body encoding, and the Bcc-never-a-header privacy contract.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type MailMessage, messageHeaders } from './driver';
import {
  addressDomain,
  addressSpec,
  buildMimeMessage,
  encodeHeaderValue,
  foldHeaderLine,
  type MimeOptions,
  quotedPrintable,
  rfc5322Date,
} from './mime';

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

/** A minimal, independent quoted-printable decoder — the round-trip test's only oracle. */
function decodeQuotedPrintable(encoded: string): string {
  const withoutSoftBreaks = encoded.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  let index = 0;
  while (index < withoutSoftBreaks.length) {
    const char = withoutSoftBreaks[index] ?? '';
    if (char === '=') {
      const hex = withoutSoftBreaks.slice(index + 1, index + 3);
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    } else {
      bytes.push(char.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe('buildMimeMessage', () => {
  test('headers appear in the exact required order, then one blank line, then the body', () => {
    const message = baseMessage({
      to: ['ada@example.test', 'grace@example.test'],
      cc: ['lin@example.test'],
      replyTo: 'support@postly.test',
      unsubscribeUrl: 'https://postly.test/u/123',
    });
    const built = buildMimeMessage(message, baseOptions());

    const separatorIndex = built.indexOf('\r\n\r\n');
    expect(separatorIndex).toBeGreaterThan(-1);
    const headerNames = built
      .slice(0, separatorIndex)
      .split('\r\n')
      .map((line) => line.split(':')[0]);

    expect(headerNames).toEqual([
      'From',
      'To',
      'Cc',
      'Subject',
      'Date',
      'Message-ID',
      'MIME-Version',
      'Auto-Submitted',
      'Reply-To',
      'List-Unsubscribe',
      'List-Unsubscribe-Post',
      'Content-Type',
    ]);
  });

  test('Cc is omitted entirely when there is no cc list', () => {
    const built = buildMimeMessage(baseMessage(), baseOptions());
    const headerBlock = built.slice(0, built.indexOf('\r\n\r\n'));
    expect(headerBlock.split('\r\n').some((line) => line.startsWith('Cc:'))).toBe(false);
  });

  test('the body is multipart/alternative with text first, html second, and a three-part boundary', () => {
    const message = baseMessage({ text: 'Plain body', html: '<p>Html body</p>' });
    const options = baseOptions();
    const built = buildMimeMessage(message, options);
    const body = built.slice(built.indexOf('\r\n\r\n') + 4);

    expect(body).toContain('Content-Type: text/plain; charset=utf-8');
    expect(body).toContain('Content-Type: text/html; charset=utf-8');
    expect(body).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(body.indexOf('text/plain')).toBeLessThan(body.indexOf('text/html'));

    const delimiterCount = body.split(`--${options.boundary}`).length - 1;
    expect(delimiterCount).toBe(3);
    expect(body.trimEnd().endsWith(`--${options.boundary}--`)).toBe(true);
  });

  test('every line ending is CRLF — never a bare LF', () => {
    const message = baseMessage({
      text: 'Line one\nLine two',
      html: '<p>Line one</p>\n<p>Line two</p>',
    });
    const built = buildMimeMessage(message, baseOptions());
    expect(built.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(built.includes('\r\n')).toBe(true);
  });

  test('bcc never appears as a header, and the bcc address never appears anywhere in the message', () => {
    const bccAddress = 'secret-bcc@example.test';
    const message = baseMessage({ bcc: [bccAddress] });
    const built = buildMimeMessage(message, baseOptions());
    const headerBlock = built.slice(0, built.indexOf('\r\n\r\n'));

    expect(headerBlock).not.toContain('Bcc');
    expect(built).not.toContain(bccAddress);
  });

  test('every messageHeaders() entry reaches the output exactly once', () => {
    const message = baseMessage({
      replyTo: 'support@postly.test',
      unsubscribeUrl: 'https://postly.test/u/42',
    });
    const built = buildMimeMessage(message, baseOptions());

    for (const [name, value] of Object.entries(messageHeaders(message))) {
      const needle = `${name}: ${value}`;
      expect(built.split(needle).length - 1).toBe(1);
    }
  });

  test('no quoted-printable body line exceeds 76 chars, and no line in the message exceeds 998', () => {
    const longLine = 'word '.repeat(40);
    const message = baseMessage({ text: longLine, html: `<p>${longLine}</p>` });
    const built = buildMimeMessage(message, baseOptions());

    for (const line of built.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);

    const body = built.slice(built.indexOf('\r\n\r\n') + 4);
    const contentLines = body
      .split('\r\n')
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('--') &&
          !line.startsWith('Content-Type:') &&
          !line.startsWith('Content-Transfer-Encoding:'),
      );
    expect(contentLines.length).toBeGreaterThan(0);
    for (const line of contentLines) expect(line.length).toBeLessThanOrEqual(76);
  });
});

describe('encodeHeaderValue', () => {
  test('a pure-ASCII subject passes through unencoded', () => {
    const subject = 'Weekly report is ready';
    expect(encodeHeaderValue(subject)).toBe(subject);
  });

  test('a long non-ASCII subject becomes encoded words, each <= 75 chars, that decode back exactly', () => {
    const subject = `Réservation confirmée — café ☕ événement ${'Ünïcödé texte '.repeat(8)}`;
    const encoded = encodeHeaderValue(subject);
    const words = encoded.split(' ');
    expect(words.length).toBeGreaterThan(1);

    let decoded = '';
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
      expect(match).not.toBeNull();
      const base64 = match?.[1] ?? '';
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      decoded += new TextDecoder().decode(bytes);
    }
    expect(decoded).toBe(subject);
  });
});

describe('quotedPrintable', () => {
  test('round-trips = signs, emoji, accents, trailing spaces and an over-length line', () => {
    const input = [
      'Line with an = sign',
      'Emoji party 🎉 and café',
      'trailing spaces   ',
      'x'.repeat(90),
      'last line, no trailing break',
    ].join('\r\n');

    const encoded = quotedPrintable(input);
    for (const line of encoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeQuotedPrintable(encoded)).toBe(input);
  });

  test('normalises a bare \\n to \\r\\n without ever doubling an existing \\r\\n', () => {
    const mixed = 'a\nb\r\nc';
    const encoded = quotedPrintable(mixed);
    expect(encoded).not.toContain('\r\r\n');
    expect(decodeQuotedPrintable(encoded)).toBe('a\r\nb\r\nc');
  });

  // A literal trailing space/tab decodes identically to its `=20`/`=09` escape, so the round-trip
  // test above cannot tell them apart. Assert the escaping structurally instead.
  test('a trailing space or tab is escaped, never left as the last literal byte of a line', () => {
    const encoded = quotedPrintable('value:   ');
    expect(encoded.endsWith(' ')).toBe(false);
    expect(encoded.endsWith('\t')).toBe(false);
    expect(encoded).toContain('=20');
    expect(decodeQuotedPrintable(encoded)).toBe('value:   ');
  });
});

describe('rfc5322Date', () => {
  test('formats a known instant as the exact UTC string, offset always +0000', () => {
    expect(rfc5322Date(new Date('2026-08-09T12:34:56Z'))).toBe('Sun, 09 Aug 2026 12:34:56 +0000');
  });
});

describe('addressSpec / addressDomain', () => {
  test('addressSpec strips a display name; a bare address is returned as-is', () => {
    expect(addressSpec('Postly <no-reply@postly.test>')).toBe('no-reply@postly.test');
    expect(addressSpec('no-reply@postly.test')).toBe('no-reply@postly.test');
  });

  test('addressDomain returns the part after the last @, in either address form', () => {
    expect(addressDomain('Postly <no-reply@postly.test>')).toBe('postly.test');
    expect(addressDomain('no-reply@postly.test')).toBe('postly.test');
  });
});

describe('foldHeaderLine', () => {
  test('a long address list folds after a comma, each continuation with a single leading space', () => {
    const addresses = Array.from({ length: 10 }, (_, i) => `recipient-${i}@example.test`);
    const folded = foldHeaderLine('To', addresses.join(', '));
    const lines = folded.split('\r\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    // Stripping just the CRLFs must reconstruct the original, unfolded header exactly —
    // folding may only insert line breaks at existing spaces, never lose or reorder content.
    expect(folded.replace(/\r\n/g, '')).toBe(`To: ${addresses.join(', ')}`);
  });

  test('a single unbreakable token is left on one line even past 78 chars', () => {
    const longToken = `<${'a'.repeat(100)}@example.test>`;
    const folded = foldHeaderLine('Message-ID', longToken);
    expect(folded).toBe(`Message-ID: ${longToken}`);
    expect(folded.includes('\r\n')).toBe(false);
  });

  test('a run of spaces inside a value survives folding', () => {
    const value = `${'word '.repeat(20)}two  spaces`;
    const folded = foldHeaderLine('Subject', value);

    expect(folded.split('\r\n').length).toBeGreaterThan(1);
    expect(folded.replace(/\r\n/g, '')).toBe(`Subject: ${value}`);
  });
});

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

  test('a break in the body is fine — only headers can be injected', () => {
    const message = baseMessage({ text: 'line one\r\nline two', html: '<p>a</p>\n<p>b</p>' });

    expect(buildMimeMessage(message, baseOptions())).toContain('line one');
  });
});
