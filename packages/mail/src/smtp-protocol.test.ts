import { describe, expect, test } from 'bun:test';
import { base64Utf8 } from './base64';
import {
  authPlain,
  createReplyParser,
  dotStuff,
  isPositive,
  isTransient,
  parseCapabilities,
  replySummary,
  type SmtpReply,
} from './smtp-protocol';

/** Decodes what `base64Utf8`/`authPlain` produced, the long way, so the test does not trust
 * the code under test to check itself. */
const decodeBase64Utf8 = (encoded: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));

/** A minimal `SmtpReply` fixture — `parseCapabilities` only ever reads `.lines`. */
const replyFrom = (lines: readonly string[]): SmtpReply => ({
  code: 250,
  lines,
  text: lines.join(' '),
});

describe('createReplyParser', () => {
  test('a multi-line 250 reply parses to one SmtpReply', () => {
    const parser = createReplyParser();
    const replies = parser.push('250-STARTTLS\r\n250-SIZE 100\r\n250 OK\r\n');

    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      code: 250,
      lines: ['STARTTLS', 'SIZE 100', 'OK'],
      text: 'STARTTLS SIZE 100 OK',
    });
  });

  test('fed one character per push(), the same reply yields exactly one reply', () => {
    const parser = createReplyParser();
    const wire = '250 OK\r\n';
    const collected: SmtpReply[] = [];
    let sawPendingMidway = false;

    for (const char of wire) {
      collected.push(...parser.push(char));
      if (parser.hasPending()) sawPendingMidway = true;
    }

    expect(collected).toEqual([{ code: 250, lines: ['OK'], text: 'OK' }]);
    expect(sawPendingMidway).toBe(true);
    expect(parser.hasPending()).toBe(false);
  });

  test('two replies in one chunk yield two replies in order', () => {
    const parser = createReplyParser();
    const replies = parser.push('250 first\r\n550 second\r\n');

    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual({ code: 250, lines: ['first'], text: 'first' });
    expect(replies[1]).toEqual({ code: 550, lines: ['second'], text: 'second' });
  });

  test('a chunk splitting \\r\\n across two push() calls still yields one reply', () => {
    const parser = createReplyParser();

    expect(parser.push('250 OK\r')).toEqual([]);
    expect(parser.hasPending()).toBe(true);

    const replies = parser.push('\n');
    expect(replies).toEqual([{ code: 250, lines: ['OK'], text: 'OK' }]);
    expect(parser.hasPending()).toBe(false);
  });

  test('a garbage line between two replies is skipped; both replies still parse', () => {
    const parser = createReplyParser();
    const replies = parser.push('250 first\r\nhello there\r\n250 second\r\n');

    expect(replies).toHaveLength(2);
    expect(replies[0]?.text).toBe('first');
    expect(replies[1]?.text).toBe('second');
  });

  test('blank lines between replies are ignored, not treated as garbage or a reply', () => {
    const parser = createReplyParser();
    const replies = parser.push('250 first\r\n\r\n250 second\r\n');

    expect(replies).toHaveLength(2);
    expect(replies.map((reply) => reply.code)).toEqual([250, 250]);
  });

  test('hasPending is true once a continuation line lands with no final line yet', () => {
    const parser = createReplyParser();

    expect(parser.push('250-STARTTLS\r\n')).toEqual([]);
    expect(parser.hasPending()).toBe(true); // a close here would die mid-reply

    const replies = parser.push('250 OK\r\n');
    expect(replies).toEqual([{ code: 250, lines: ['STARTTLS', 'OK'], text: 'STARTTLS OK' }]);
    expect(parser.hasPending()).toBe(false);
  });

  test('a bare final line with no text parses to an empty-text reply, not a crash', () => {
    const parser = createReplyParser();
    const replies = parser.push('250\r\n');

    expect(replies).toEqual([{ code: 250, lines: [''], text: '' }]);
  });

  test('a chunk of only garbage produces no replies and does not throw', () => {
    const parser = createReplyParser();
    expect(() => parser.push('not an smtp line\r\nneither is this\r\n')).not.toThrow();
    expect(parser.push('still nothing\r\n')).toEqual([]);
  });
});

describe('parseCapabilities', () => {
  test('a realistic EHLO reply returns every field', () => {
    const capabilities = parseCapabilities(
      replyFrom([
        'mail.example.test greets you',
        'PIPELINING',
        'SIZE 35882577',
        'STARTTLS',
        'AUTH PLAIN LOGIN',
        '8BITMIME',
      ]),
    );

    expect(capabilities).toEqual({
      starttls: true,
      authMechanisms: ['PLAIN', 'LOGIN'],
      maxSizeBytes: 35882577,
      eightBitMime: true,
      pipelining: true,
    });
  });

  test('the same reply parsed end to end through the wire parser', () => {
    const parser = createReplyParser();
    const [reply] = parser.push(
      '250-mail.example.test greets you\r\n' +
        '250-PIPELINING\r\n' +
        '250-SIZE 35882577\r\n' +
        '250-STARTTLS\r\n' +
        '250-AUTH PLAIN LOGIN\r\n' +
        '250 8BITMIME\r\n',
    );

    expect(reply).toBeDefined();
    expect(parseCapabilities(reply as SmtpReply)).toEqual({
      starttls: true,
      authMechanisms: ['PLAIN', 'LOGIN'],
      maxSizeBytes: 35882577,
      eightBitMime: true,
      pipelining: true,
    });
  });

  test('a server without STARTTLS returns starttls: false', () => {
    const capabilities = parseCapabilities(
      replyFrom(['greeting', 'PIPELINING', 'AUTH PLAIN LOGIN']),
    );

    expect(capabilities.starttls).toBe(false);
    expect(capabilities.pipelining).toBe(true);
  });

  test('SIZE with no number returns no maxSizeBytes — undefined, not NaN', () => {
    const capabilities = parseCapabilities(replyFrom(['greeting', 'SIZE']));

    expect(capabilities.maxSizeBytes).toBeUndefined();
    expect(Number.isNaN(capabilities.maxSizeBytes)).toBe(false);
  });

  test('SIZE with a non-numeric value also returns no maxSizeBytes', () => {
    const capabilities = parseCapabilities(replyFrom(['greeting', 'SIZE unlimited']));

    expect(capabilities.maxSizeBytes).toBeUndefined();
  });

  test('the legacy AUTH=PLAIN LOGIN form parses too', () => {
    const capabilities = parseCapabilities(replyFrom(['greeting', 'AUTH=PLAIN LOGIN']));

    expect(capabilities.authMechanisms).toEqual(['PLAIN', 'LOGIN']);
  });

  test('AUTH mechanisms are upper-cased even when the server sends them lower-case', () => {
    const capabilities = parseCapabilities(replyFrom(['greeting', 'auth plain login']));

    expect(capabilities.authMechanisms).toEqual(['PLAIN', 'LOGIN']);
  });

  test('a reply with only a greeting line yields every default and no capabilities', () => {
    const capabilities = parseCapabilities(replyFrom(['greeting only']));

    expect(capabilities).toEqual({
      starttls: false,
      authMechanisms: [],
      maxSizeBytes: undefined,
      eightBitMime: false,
      pipelining: false,
    });
  });
});

describe('authPlain / base64Utf8', () => {
  test("authPlain('ada','pw') decodes back to \\0ada\\0pw", () => {
    expect(decodeBase64Utf8(authPlain('ada', 'pw'))).toBe('\0ada\0pw');
  });

  test('a non-ASCII password round-trips through UTF-8', () => {
    expect(decodeBase64Utf8(authPlain('ada', 'sécrét🔑'))).toBe('\0ada\0sécrét🔑');
  });

  test('base64Utf8 round-trips plain ASCII', () => {
    expect(decodeBase64Utf8(base64Utf8('hello world'))).toBe('hello world');
  });

  test('base64Utf8 round-trips multi-byte UTF-8 outside the Latin-1 range', () => {
    expect(decodeBase64Utf8(base64Utf8('café ☕ 世界'))).toBe('café ☕ 世界');
  });
});

describe('dotStuff', () => {
  test('a line starting with . is doubled', () => {
    expect(dotStuff('.hello\r\n')).toBe('..hello\r\n');
  });

  test('a . in the middle of a line is untouched', () => {
    expect(dotStuff('hel.lo\r\n')).toBe('hel.lo\r\n');
  });

  test('a lone \\n becomes \\r\\n', () => {
    expect(dotStuff('a\nb')).toBe('a\r\nb');
  });

  test('an existing \\r\\n is unchanged — never doubled to \\r\\r\\n', () => {
    expect(dotStuff('a\r\nb')).toBe('a\r\nb');
  });

  test('a body of exactly . becomes ..', () => {
    expect(dotStuff('.')).toBe('..');
  });

  test('a body already ending in \\r\\n does not gain a blank line', () => {
    expect(dotStuff('a\r\nb\r\n')).toBe('a\r\nb\r\n');
  });

  test('a body ending in a lone \\n normalises without gaining a blank line', () => {
    expect(dotStuff('a\nb\n')).toBe('a\r\nb\r\n');
  });

  test("does not append the DATA terminator — that is the caller's job", () => {
    expect(dotStuff('a\r\n')).not.toContain('..');
    expect(dotStuff('a\r\n').endsWith('\r\n.\r\n')).toBe(false);
  });
});

describe('isTransient / isPositive', () => {
  test('isTransient is true only for 4xx', () => {
    expect(isTransient(399)).toBe(false);
    expect(isTransient(400)).toBe(true);
    expect(isTransient(499)).toBe(true);
    expect(isTransient(500)).toBe(false);
  });

  test('isPositive is true only for 2xx', () => {
    expect(isPositive(199)).toBe(false);
    expect(isPositive(200)).toBe(true);
    expect(isPositive(299)).toBe(true);
    expect(isPositive(300)).toBe(false);
  });
});

describe('replySummary', () => {
  test('formats code and text as one line', () => {
    const reply: SmtpReply = {
      code: 550,
      lines: ['5.1.1 no such user'],
      text: '5.1.1 no such user',
    };

    expect(replySummary(reply)).toBe('550 5.1.1 no such user');
  });

  test('a multi-line reply still summarises to a single line', () => {
    const reply: SmtpReply = {
      code: 250,
      lines: ['STARTTLS', 'SIZE 100', 'OK'],
      text: 'STARTTLS SIZE 100 OK',
    };

    expect(replySummary(reply)).toBe('250 STARTTLS SIZE 100 OK');
    expect(replySummary(reply)).not.toContain('\n');
  });

  test('an empty-text reply has no trailing space', () => {
    expect(replySummary({ code: 250, lines: [''], text: '' })).toBe('250');
  });
});
