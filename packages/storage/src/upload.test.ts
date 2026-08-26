import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import {
  contentTypeMatches,
  normalizeContentType,
  sniffContentType,
  uploadPolicy,
  validateUpload,
} from './upload';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Signature + a plausible IHDR chunk header: enough for a sniffer, not a decoder. */
function genuinePng(padding = 64): Uint8Array {
  const header = [...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
  return new Uint8Array([...header, ...new Array<number>(padding).fill(0x01)]);
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const IMAGES = uploadPolicy({ maxBytes: 1024, allowedContentTypes: ['image/png', 'image/jpeg'] });

describe('sniffContentType', () => {
  test('reads the magic bytes, not the extension', () => {
    expect(sniffContentType(genuinePng())).toBe('image/png');
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(bytesOf('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffContentType(bytesOf('<!DOCTYPE html><p>hi'))).toBe('text/html');
    expect(sniffContentType(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml',
    );
    expect(sniffContentType(bytesOf('id,name\n1,a\n'))).toBe('text/plain');
  });
});

describe('normalizeContentType', () => {
  test('an Object.prototype key normalises to itself, never to a function', () => {
    // `ALIASES[base] ?? base` reached the prototype chain, so a `Content-Type: constructor` header
    // came back as the `Object` FUNCTION through a `: string` signature — reachable from
    // `acceptSignedUpload` with the transport's own header, where the refusal's `cause` and
    // `meta.declared` then carried a function's source instead of a media type.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(normalizeContentType(key)).toBe(key.toLowerCase());
      expect(typeof normalizeContentType(key)).toBe('string');
    }
    expect(normalizeContentType('IMAGE/JPG; charset=binary')).toBe('image/jpeg');
    expect(contentTypeMatches('constructor', 'text/plain')).toBe(false);
  });
});

describe('validateUpload', () => {
  test('accepts a genuine PNG declared as image/png', () => {
    const result = validateUpload(
      { key: 'org/org-1/avatars/a.png', declaredContentType: 'image/png', bytes: genuinePng() },
      IMAGES,
    );
    expect(result.contentType).toBe('image/png');
    expect(result.size).toBe(80);
    expect(result.checksum.length).toBeGreaterThan(0);
  });

  // The ORDER the doc comment states, pinned: key, size, type, checksum. It said "size, key, type,
  // checksum" while the body asserted the key first, so a caller reading the comment expected
  // X_STORAGE_TOO_LARGE for a candidate that is both unsafe and oversized. Which constraint a
  // rejected upload reports is what the client retries on, so the order is behaviour, not prose —
  // and the key comes first because a key nothing may store makes the other three moot.
  test('reports the key before the size when a candidate violates both', () => {
    const code = codeOf(() =>
      validateUpload(
        {
          key: '../../etc/passwd',
          declaredContentType: 'image/png',
          bytes: genuinePng(4096),
        },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_PATH_UNSAFE');
  });

  test('normalises the declared type before matching it', () => {
    const result = validateUpload(
      {
        key: 'org/org-1/a.jpg',
        declaredContentType: 'IMAGE/JPG; charset=binary',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      },
      IMAGES,
    );
    expect(result.contentType).toBe('image/jpeg');
  });

  // The whole point of sniffing: Content-Type is attacker-controlled, and an HTML document
  // served back as a .png is stored XSS.
  test('rejects HTML bytes wearing an image/png Content-Type', () => {
    const html = bytesOf('<!DOCTYPE html><script>fetch("/steal")</script>');
    const code = codeOf(() =>
      validateUpload(
        { key: 'org/org-1/avatars/evil.png', declaredContentType: 'image/png', bytes: html },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('the mismatch error names both types', () => {
    let caught: unknown;
    try {
      validateUpload(
        {
          key: 'org/org-1/avatars/evil.png',
          declaredContentType: 'image/png',
          bytes: bytesOf('<html><body>hi</body></html>'),
        },
        IMAGES,
      );
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught)).toBe(true);
    const cause = isStorageError(caught) ? caught.cause : '';
    expect(cause).toContain('image/png');
    expect(cause).toContain('text/html');
  });

  test('rejects a type that is not on the allowlist at all', () => {
    const code = codeOf(() =>
      validateUpload(
        { key: 'org/org-1/a.pdf', declaredContentType: 'application/pdf', bytes: bytesOf('%PDF-') },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('rejects an oversize payload before it looks at the type', () => {
    const code = codeOf(() =>
      validateUpload(
        {
          key: 'org/org-1/avatars/big.png',
          declaredContentType: 'image/png',
          bytes: genuinePng(4096),
        },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_TOO_LARGE');
  });

  test('rejects an unsafe key', () => {
    const code = codeOf(() =>
      validateUpload(
        { key: '../a.png', declaredContentType: 'image/png', bytes: genuinePng() },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_PATH_UNSAFE');
  });

  test('rejects a checksum that does not describe the bytes', () => {
    const code = codeOf(() =>
      validateUpload(
        {
          key: 'org/org-1/a.png',
          declaredContentType: 'image/png',
          bytes: genuinePng(),
          checksum: 'not-the-hash',
        },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_CHECKSUM_MISMATCH');
  });
});

/**
 * An SVG is a script document that a browser executes when it is served back as `image/svg+xml`
 * from the app's own origin — so it was stored XSS on every app that took the default policy,
 * with the sniffer PROMOTING `<svg` to the allowed type rather than refusing it. An app that
 * genuinely serves user SVG says so, once, in `allowedContentTypes`.
 */
describe('the default upload policy', () => {
  test('does not allow image/svg+xml', () => {
    expect(uploadPolicy().allowedContentTypes).not.toContain('image/svg+xml');
  });

  test('refuses a sniffed SVG under the default policy, with the code that says why', () => {
    const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(
      codeOf(() =>
        validateUpload(
          { key: 'a/logo.svg', declaredContentType: 'image/svg+xml', bytes: svg },
          uploadPolicy(),
        ),
      ),
    ).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('an app that wants SVG opts in explicitly and still gets it', () => {
    const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const validated = validateUpload(
      { key: 'a/logo.svg', declaredContentType: 'image/svg+xml', bytes: svg },
      uploadPolicy({ allowedContentTypes: ['image/svg+xml'] }),
    );
    expect(validated.contentType).toBe('image/svg+xml');
  });
});

/**
 * `size > policy.maxBytes` is FALSE when the ceiling is `NaN`, so the one number deciding how much
 * a caller may store stops deciding anything. Measured before the screen landed:
 * `uploadPolicy({ maxBytes: Number.NaN })` accepted a 5,000,016-byte PNG through `validateUpload`,
 * with no error and no log line. `Number(process.env.MAX_UPLOAD_BYTES)` on an unset variable is
 * how it arrives.
 */
describe('the upload ceiling is screened where it is declared', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5])(
    'refuses maxBytes %p, naming it',
    (maxBytes) => {
      const rendered = codeOf(() => uploadPolicy({ maxBytes }));
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('maxBytes');
    },
  );

  test('a real ceiling still builds a policy and still refuses what is over it', () => {
    expect(uploadPolicy({ maxBytes: 1024 }).maxBytes).toBe(1024);
    expect(
      codeOf(() =>
        validateUpload(
          { key: 'a/b.png', declaredContentType: 'image/png', bytes: genuinePng(2048) },
          IMAGES,
        ),
      ),
    ).toBe('X_STORAGE_TOO_LARGE');
  });
});

/**
 * `??` coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON
 * config carries for a key someone blanked — took the default BEFORE the guard above could refuse
 * it. The mirror of the `NaN` half: one slips past the guard, the other past the default, and both
 * end in a bound nobody chose. `JSON.parse` rather than a literal, because `null` is not in the
 * option's type and this is the caller the bug is about.
 */
describe('an explicitly null upload ceiling is refused, never defaulted', () => {
  test('uploadPolicy({ maxBytes: null }) names maxBytes', () => {
    const fromJson: number = JSON.parse('null');
    let rendered = 'no-error-thrown';
    try {
      uploadPolicy({ maxBytes: fromJson });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('maxBytes');
  });
});
