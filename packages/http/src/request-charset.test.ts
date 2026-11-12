// A text/* body is text in the charset its header declares — `text/plain; charset=iso-8859-1`
// read as UTF-8 turned every accented byte into U+FFFD. JSON and forms stay UTF-8 by definition.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { requestContext } from './context';
import { UltimateRequest } from './request';

const posted = (body: Uint8Array<ArrayBuffer>, contentType: string): UltimateRequest => {
  const url = new URL('https://example.com/x');
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'POST', role: 'web', config });
  const headers = { 'content-type': contentType };
  return new UltimateRequest(new Request(url, { method: 'POST', body, headers }), ctx);
};

/** `café` in Latin-1: the `é` is the single byte 0xE9, which is not valid UTF-8. */
const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);

describe('bodyRaw() — the charset of a text/* body', () => {
  test('a text/* body is decoded by its declared charset', async () => {
    for (const type of [
      'text/plain; charset=iso-8859-1',
      'text/csv;charset="ISO-8859-1"',
      'text/plain; format=flowed; charset=latin1',
    ]) {
      expect(await posted(latin1, type).bodyRaw()).toBe('café');
    }
  });

  test('no charset is UTF-8, as it always was', async () => {
    const utf8 = Uint8Array.from(new TextEncoder().encode('café'));
    expect(await posted(utf8, 'text/plain').bodyRaw()).toBe('café');
  });

  test('a charset no decoder knows is X_BODY_INVALID, never a silent UTF-8 read', async () => {
    try {
      await posted(latin1, 'text/plain; charset=x-made-up').bodyRaw();
      expect.unreachable('an unknown charset was decoded anyway');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_BODY_INVALID' });
    }
  });

  test('JSON stays UTF-8 whatever charset it claims', async () => {
    const json = Uint8Array.from(new TextEncoder().encode('{"name":"café"}'));
    const read = posted(json, 'application/json; charset=iso-8859-1').bodyRaw();
    expect(await read).toEqual({ name: 'café' });
  });
});

describe('bodyRaw() — only the stateless charsets are honoured', () => {
  test('utf-16be decodes', async () => {
    const utf16be = Uint8Array.from([0x00, 0x63, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9]);
    expect(await posted(utf16be, 'text/plain; charset=utf-16be').bodyRaw()).toBe('café');
  });

  test('windows-1252 and utf-8 by label decode', async () => {
    expect(await posted(latin1, 'text/plain; charset=windows-1252').bodyRaw()).toBe('café');
    const utf8 = Uint8Array.from(new TextEncoder().encode('café'));
    expect(await posted(utf8, 'text/plain; charset=UTF-8').bodyRaw()).toBe('café');
  });

  test('a label the decoder knows but the allowlist does not is X_BODY_INVALID', async () => {
    for (const label of ['iso-2022-jp', 'x-user-defined', 'gb18030']) {
      try {
        await posted(latin1, `text/plain; charset=${label}`).bodyRaw();
        expect.unreachable(`${label} was decoded`);
      } catch (error) {
        expect(error).toMatchObject({ code: 'X_BODY_INVALID' });
      }
    }
  });
});
