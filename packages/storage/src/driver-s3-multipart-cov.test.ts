// `xmlText`'s numeric character references: a gateway writes an etag's quotes as `&#34;` where S3
// writes `&quot;`, and an etag read with its quotes still escaped never matches the stored one.

import { describe, expect, test } from 'bun:test';
import { xmlText } from './driver-s3-multipart';

describe('xmlText numeric references', () => {
  test('decimal and hex (either case of x) decode to the character they name', () => {
    expect(xmlText('&#34;abc&#x22;')).toBe('"abc"');
    expect(xmlText('&#X41;&#97;')).toBe('Aa');
  });

  test('a code point past Unicode is clamped to the last one, never a thrown RangeError', () => {
    expect(xmlText('&#9999999;')).toBe(String.fromCodePoint(0x10ffff));
  });

  test('a reference decodes once: an escaped ampersand before it is not re-read', () => {
    expect(xmlText('&amp;#34;')).toBe('&#34;');
  });
});
