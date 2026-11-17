// `transportText`'s redaction: a runtime's message quoting a proxy URL or a signed URL keeps
// neither the userinfo nor the query, however many raw `@` the password holds.

import { describe, expect, test } from 'bun:test';
import { transportText } from './outbound-errors';

describe('transportText', () => {
  test('cuts a proxy password holding a raw `@` whole, not at its first `@`', () => {
    const text = transportText(
      new TypeError('connect failed via http://u:hunter@2secret@proxy:3128'),
    );
    expect(text).not.toContain('2secret');
    expect(text).toContain('http://…@proxy:3128');
  });

  test('cuts the query of a signed URL', () => {
    const text = transportText(
      new TypeError('GET https://bucket.test/o?X-Amz-Signature=abc failed'),
    );
    expect(text).not.toContain('abc');
    expect(text).toContain('https://bucket.test/o?…');
  });
});
