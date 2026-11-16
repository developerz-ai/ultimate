// The computed headers on the wire: `Reply-To` through the address path, a display phrase that
// needs quoting, and `List-Unsubscribe` normalised to 7-bit. Apart from `mime.test.ts`, which holds
// the builder's framing, folding and body encoding.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type MailMessage, messageHeaders } from './driver';
import { buildMimeMessage, encodeAddressPhrase, type MimeOptions } from './mime';

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

function headerLine(built: string, name: string): string {
  const block = built.slice(0, built.indexOf('\r\n\r\n'));
  const unfolded = block.split('\r\n ').join(' ');
  return unfolded.split('\r\n').find((line) => line.startsWith(`${name}: `)) ?? '';
}

function isSevenBit(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Reply-To goes through the address path', () => {
  test('a non-ASCII display name becomes an encoded word over a verbatim mailbox', () => {
    const built = buildMimeMessage(
      baseMessage({ replyTo: 'José Muñoz <jose@x.test>' }),
      baseOptions(),
    );
    const line = headerLine(built, 'Reply-To');
    expect(isSevenBit(line)).toBe(true);
    expect(line).toContain('=?UTF-8?B?');
    expect(line.endsWith(' <jose@x.test>')).toBe(true);
  });

  test('a non-ASCII mailbox is refused, and the refusal says why', () => {
    const error = thrown(() =>
      buildMimeMessage(baseMessage({ replyTo: 'josé@exämple.test' }), baseOptions()),
    );
    expect(isUltimateError(error) ? [error.code, error.meta?.['reason']] : error).toEqual([
      'X_MAIL_HEADER_INVALID',
      'non-ascii',
    ]);
    expect(isUltimateError(error) ? error.cause : '').not.toContain('CR or LF');
  });

  test('a line break keeps its own reason', () => {
    const error = thrown(() =>
      buildMimeMessage(baseMessage({ replyTo: 'a@x.test\r\nBcc: e@evil.test' }), baseOptions()),
    );
    expect(isUltimateError(error) ? error.meta?.['reason'] : error).toBe('line-break');
  });
});

describe('a display phrase holding a special is quoted', () => {
  test('a comma in a To phrase no longer splits the address list', () => {
    const built = buildMimeMessage(
      baseMessage({ to: ['Doe, Jane <jane@x.test>', 'ada@example.test'] }),
      baseOptions(),
    );
    expect(headerLine(built, 'To')).toBe('To: "Doe, Jane" <jane@x.test>, ada@example.test');
  });

  test('From, Cc and Reply-To are quoted the same way', () => {
    const built = buildMimeMessage(
      baseMessage({ cc: ['Ops; Night <ops@x.test>'], replyTo: 'Support (EU) <s@x.test>' }),
      baseOptions({ from: 'Postly, Inc. <no-reply@postly.test>' }),
    );
    expect(headerLine(built, 'From')).toBe('From: "Postly, Inc." <no-reply@postly.test>');
    expect(headerLine(built, 'Cc')).toBe('Cc: "Ops; Night" <ops@x.test>');
    expect(headerLine(built, 'Reply-To')).toBe('Reply-To: "Support (EU)" <s@x.test>');
  });

  test('a quote or backslash inside the phrase is escaped; a quoted phrase is left alone', () => {
    expect(encodeAddressPhrase('Jane "JD", Doe <jane@x.test>')).toBe(
      '"Jane \\"JD\\", Doe" <jane@x.test>',
    );
    expect(encodeAddressPhrase('"Doe, Jane" <jane@x.test>')).toBe('"Doe, Jane" <jane@x.test>');
    expect(encodeAddressPhrase('Jane Q. Doe <jane@x.test>')).toBe('Jane Q. Doe <jane@x.test>');
    expect(encodeAddressPhrase('jane@x.test')).toBe('jane@x.test');
  });
});

describe('List-Unsubscribe is normalised', () => {
  const url = 'https://exämple.test/ünsub?u=é';

  test('a non-ASCII url reaches the wire as 7-bit, in the Resend headers and in the SMTP message', () => {
    const headers = messageHeaders(baseMessage({ unsubscribeUrl: url }));
    expect(headers['List-Unsubscribe']).toBe('<https://xn--exmple-cua.test/%C3%BCnsub?u=%C3%A9>');
    const line = headerLine(
      buildMimeMessage(baseMessage({ unsubscribeUrl: url }), baseOptions()),
      'List-Unsubscribe',
    );
    expect(isSevenBit(line)).toBe(true);
  });

  test('a bracket in the url cannot close the angle-bracket early', () => {
    const headers = messageHeaders(baseMessage({ unsubscribeUrl: 'https://x.test/u?a=>b' }));
    expect(headers['List-Unsubscribe']).toBe('<https://x.test/u?a=%3Eb>');
  });
});
