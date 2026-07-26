import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import { sniffContentType, uploadPolicy, validateUpload } from './upload';

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
