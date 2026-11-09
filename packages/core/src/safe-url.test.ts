import { describe, expect, test } from 'bun:test';
import { safeUrl, URL_ATTRIBUTES } from './safe-url';

describe('safeUrl', () => {
  test('a javascript: URL is refused in every URL-bearing attribute', () => {
    for (const attribute of URL_ATTRIBUTES) {
      expect(safeUrl('javascript:alert(1)', attribute)).toBeNull();
      expect(safeUrl('JaVaScRiPt:alert(1)', attribute)).toBeNull();
    }
  });

  test('the control characters a browser strips before parsing cannot smuggle a scheme', () => {
    // A browser deletes TAB, CR and LF from a URL before parsing it, so the scheme has to be read
    // off the stripped form or `java&#9;script:` is followed as `javascript:`.
    expect(safeUrl('java\tscript:alert(1)', 'href')).toBeNull();
    expect(safeUrl('java\nscript:alert(1)', 'href')).toBeNull();
    expect(safeUrl('  \r\n javascript:alert(1)', 'href')).toBeNull();
    expect(safeUrl('\0javascript:alert(1)', 'href')).toBeNull();
  });

  test('vbscript: and data: are refused where the value is navigated to', () => {
    expect(safeUrl('vbscript:msgbox(1)', 'href')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>', 'href')).toBeNull();
    expect(safeUrl('data:image/svg+xml,<svg onload="alert(1)"/>', 'href')).toBeNull();
  });

  test('a relative, absolute-path, query or fragment value passes through unchanged', () => {
    for (const value of ['/posts/1', 'posts/1', '?page=2', '#top', '//cdn.test/a.png', '']) {
      expect(safeUrl(value, 'href')).toBe(value);
    }
  });

  test('the schemes a link may carry pass through unchanged', () => {
    for (const value of [
      'https://ultimate.dev',
      'http://ultimate.dev',
      'mailto:ada@ultimate.dev',
      'tel:+441234567890',
      'sms:+441234567890',
    ]) {
      expect(safeUrl(value, 'href')).toBe(value);
    }
  });

  test('data:image is kept for src only — bytes rendered, never navigated to', () => {
    const blur = 'data:image/webp;base64,AAA';
    expect(safeUrl(blur, 'src')).toBe(blur);
    expect(safeUrl(blur, 'href')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>', 'src')).toBeNull();
  });

  // An SVG is a script document, so the one exemption `src` carries had a hole the size of the
  // attribute it was written for: `@ultimat3/render` routes EVERY src through here, and
  // `<iframe src="data:image/svg+xml,<svg><script>…">` runs that script — the identical string
  // being refused one attribute over in `href`. `@ultimat3/storage` deletes `image/svg+xml` from
  // its own default upload allowlist for exactly this reason.
  test('a data: SVG is refused in src too, while the raster types stay', () => {
    expect(safeUrl('data:image/svg+xml,<svg onload="alert(1)"/>', 'src')).toBeNull();
    expect(safeUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'src')).toBeNull();
    // The scheme is read off the STRIPPED form, so the trick that defeats a raw substring test
    // defeats nothing here: a browser deletes these characters before parsing too.
    expect(safeUrl('data:image/sv\tg+xml,<svg/>', 'src')).toBeNull();
    expect(safeUrl('DATA:IMAGE/SVG+XML,<svg/>', 'src')).toBeNull();
    for (const raster of [
      'data:image/webp;base64,AAA',
      'data:image/png;base64,AAA',
      'data:image/jpeg;base64,AAA',
      'data:image/gif;base64,AAA',
      'data:image/avif;base64,AAA',
    ]) {
      expect(safeUrl(raster, 'src')).toBe(raster);
    }
  });

  test('an unknown scheme is refused rather than guessed at', () => {
    expect(safeUrl('file:///etc/passwd', 'href')).toBeNull();
    expect(safeUrl('chrome-extension://abc/x.js', 'src')).toBeNull();
  });
});

// The fast path (no control character or space → no copy) must answer exactly what the code-point
// strip answers. The reference below is that strip, verbatim, over a corpus of every scheme shape.
describe('safeUrl · the fast path changes no answer', () => {
  const SAFE = ['http:', 'https:', 'mailto:', 'tel:', 'sms:'];
  const reference = (value: string, attribute: string): string | null => {
    const stripped = [...value]
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code > 0x20 && code !== 0x7f;
      })
      .join('');
    const matched = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(stripped);
    if (matched === null) return value;
    if (SAFE.includes(matched[0].toLowerCase())) return value;
    if (attribute === 'src' && stripped.slice(0, 11).toLowerCase() === 'data:image/') {
      return stripped.slice(11).toLowerCase().startsWith('svg') ? null : value;
    }
    return null;
  };
  const bases = [
    '/a/b?c=1#d',
    '//evil.test/x',
    '/\\evil.test',
    'relative/path',
    '?q=1',
    '#frag',
    'https://ok.test/',
    'HTTP://ok.test',
    'mailto:a@b.c',
    'javascript:alert(1)',
    'vbscript:x',
    'data:image/png;base64,AA',
    'data:image/svg+xml,<svg>',
    'data:text/html,x',
    'ftp://x',
    'c:\\windows',
    '',
  ];
  const noise = ['', ' ', '\t', '\n', '\r', '\u0000', '\u001f', '\u007f', '\u00a0', '😀'];

  test('every base, with noise before, inside and after it, in every URL attribute', () => {
    for (const attribute of [...URL_ATTRIBUTES, 'data', 'poster']) {
      for (const base of bases) {
        for (const n of noise) {
          const middle = Math.min(4, base.length);
          for (const value of [
            `${n}${base}`,
            `${base.slice(0, middle)}${n}${base.slice(middle)}`,
            `${base}${n}`,
          ]) {
            expect(safeUrl(value, attribute)).toBe(reference(value, attribute));
          }
        }
      }
    }
  });
});
