// The one pure half of the router's DOM helpers: the file name a download is saved under. A header
// is somebody else's text, so every malformed shape must come back as a name, never as a throw.
import { describe, expect, test } from 'bun:test';
import { dispositionName, isAttachment } from './navigation-dom';

describe('dispositionName', () => {
  test.each([
    [
      'a malformed escape falls back to filename',
      `attachment; filename="plain.pdf"; filename*=UTF-8''%E0%A4%A.pdf`,
      'plain.pdf',
    ],
    [
      'a path separator never survives',
      'attachment; filename="../../etc/passwd"',
      '.._.._etc_passwd',
    ],
    ['no name at all', 'attachment', ''],
  ])('%s', (_name, header, expected) => {
    expect(dispositionName(header)).toBe(expected);
  });

  test('filename* (RFC 8187) wins, decoded', () => {
    expect(
      dispositionName(
        `attachment; filename="constancia.pdf"; filename*=UTF-8''constancia%20n%C2%BA7.pdf`,
      ),
    ).toBe('constancia nº7.pdf');
    expect(dispositionName('attachment; filename=evidencia.zip')).toBe('evidencia.zip');
  });

  test('attachment is what saves; inline is shown', () => {
    expect(isAttachment('attachment; filename=a.zip')).toBe(true);
    expect(isAttachment('inline')).toBe(false);
    expect(isAttachment('')).toBe(false);
  });
});
