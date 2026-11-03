// A stored object is served from the app's own origin: which types may be shown there, and what
// every other type is answered with. The routes that serve them are asked in `@ultimat3/cli`.

import { describe, expect, test } from 'bun:test';
import { isInlineSafe, storedObjectHeaders } from './stored-object-headers';

describe('a stored object, presented', () => {
  test('only raster images, audio and video are inline — never svg, html or xml', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('IMAGE/JPEG; charset=binary')).toBe(true);
    expect(isInlineSafe('video/mp4')).toBe(true);
    for (const type of ['image/svg+xml', 'text/html', 'application/xml', 'application/pdf', '']) {
      expect(storedObjectHeaders(type)).toEqual({
        'content-disposition': 'attachment',
        'content-security-policy': 'sandbox',
      });
    }
  });
});
