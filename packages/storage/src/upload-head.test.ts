// The sniff against what would hide from it: padding in front of markup, and a head that cannot see
// the rest of its object. `validateUpload` reads a whole body and `validateStoredHead` a window, and
// both go through one rule, so each claim is asked of the path that could get it wrong.

import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import {
  MAX_LEADING_WHITESPACE,
  SNIFF_WINDOW_BYTES,
  sniffContentType,
  uploadPolicy,
  validateStoredHead,
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
const genuinePng = (): Uint8Array => new Uint8Array([...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d]);
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('leading whitespace hides nothing', () => {
  const XHTML = '<root xmlns:h="http://www.w3.org/1999/xhtml"><h:script>1</h:script></root>';
  const pad = (body: string, bytes = 512): Uint8Array => bytesOf(' '.repeat(bytes) + body);
  const TEXTS = uploadPolicy({
    maxBytes: 1024 * 1024,
    allowedContentTypes: ['application/xml', 'text/xml', 'text/plain', 'image/svg+xml'],
  });

  test('padded XHTML, HTML and SVG each sniff as they do without padding', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    for (const body of [XHTML, '<!DOCTYPE html><p>hi', '<script>1</script>', svg]) {
      expect(sniffContentType(pad(body))).toBe(sniffContentType(bytesOf(body)));
      expect(sniffContentType(pad(body))).not.toBe('text/plain');
    }
  });

  test('padded XML declared as any text type is refused, as it is without padding', () => {
    for (const declaredContentType of ['application/xml', 'text/xml', 'text/plain']) {
      const candidate = { key: 'a/x', declaredContentType, bytes: pad(XHTML) };
      expect(codeOf(() => validateUpload(candidate, TEXTS))).toBe('X_STORAGE_TYPE_REJECTED');
    }
  });

  test('past the limit is refused on both paths; at the limit it is only padding', () => {
    const over = pad('a,b', MAX_LEADING_WHITESPACE + 1);
    const at = pad('a,b', MAX_LEADING_WHITESPACE);
    const upload = (bytes: Uint8Array) =>
      validateUpload({ key: 'a/x', declaredContentType: 'text/plain', bytes }, TEXTS);
    const stored = (head: Uint8Array) =>
      validateStoredHead(
        { key: 'a/x', declaredContentType: 'text/plain', head, size: head.byteLength },
        TEXTS,
      );
    expect(codeOf(() => upload(over))).toBe('X_STORAGE_TYPE_REJECTED');
    expect(codeOf(() => stored(over))).toBe('X_STORAGE_TYPE_REJECTED');
    expect(upload(at).contentType).toBe('text/plain');
    expect(stored(at).contentType).toBe('text/plain');
  });

  test('whitespace that fails the strict sniff still counts', () => {
    const latin1 = new Uint8Array([...pad('', MAX_LEADING_WHITESPACE + 1), 0xe9]);
    const csv = uploadPolicy({ allowedContentTypes: ['text/csv'] });
    const candidate = { key: 'a/x', declaredContentType: 'text/csv', bytes: latin1 };
    expect(codeOf(() => validateUpload(candidate, csv))).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('a body with no whitespace is untouched however long', () => {
    const long = bytesOf('a,b\n'.repeat(4096));
    const candidate = { key: 'a/x', declaredContentType: 'text/plain', bytes: long };
    expect(validateUpload(candidate, TEXTS).size).toBe(long.byteLength);
  });
});

describe('validateStoredHead', () => {
  const ANY = uploadPolicy({
    maxBytes: 10 * 1024 * 1024,
    allowedContentTypes: ['image/png', 'text/plain', 'application/xml', 'image/svg+xml'],
  });
  const headOf = (
    head: Uint8Array,
    declaredContentType: string,
    size: number = head.byteLength,
  ) => ({ key: 'a/x', declaredContentType, head, size });

  test('a real type passes from its head, however large the object', () => {
    const answer = validateStoredHead(headOf(genuinePng(), 'image/png', 5_000_000), ANY);
    expect(answer).toEqual({ key: 'a/x', contentType: 'image/png', size: 5_000_000 });
  });

  test('bytes that contradict the type are refused, and the code is the upload path’s', () => {
    const html = bytesOf('<!DOCTYPE html><script>1</script>');
    expect(codeOf(() => validateStoredHead(headOf(html, 'image/png'), ANY))).toBe(
      'X_STORAGE_TYPE_REJECTED',
    );
  });

  test('a type or a size the policy refuses is refused first', () => {
    const png = genuinePng();
    expect(codeOf(() => validateStoredHead(headOf(png, 'image/webp'), ANY))).toBe(
      'X_STORAGE_TYPE_REJECTED',
    );
    expect(codeOf(() => validateStoredHead(headOf(png, 'image/png', 1e9), ANY))).toBe(
      'X_STORAGE_TOO_LARGE',
    );
    expect(
      codeOf(() => validateStoredHead({ ...headOf(png, 'image/png'), key: '../x' }, ANY)),
    ).toBe('X_STORAGE_PATH_UNSAFE');
  });

  test('a character cut at the end of the window is still text', () => {
    // `é` is two bytes: the head ends between them.
    const text = bytesOf(`${'a'.repeat(SNIFF_WINDOW_BYTES - 1)}é`);
    const head = text.subarray(0, SNIFF_WINDOW_BYTES);
    const answer = validateStoredHead(headOf(head, 'text/plain', text.byteLength), ANY);
    expect(answer.contentType).toBe('text/plain');
    // Decoded strictly, that cut gave up on the whole head, and `undefined` accepts a text type: so
    // HTML opening a large object would pass as plain text on the strength of one cut character.
    const page = bytesOf(`<!DOCTYPE html>${'a'.repeat(SNIFF_WINDOW_BYTES - 16)}é`);
    const cutPage = page.subarray(0, SNIFF_WINDOW_BYTES);
    expect(
      codeOf(() => validateStoredHead(headOf(cutPage, 'text/plain', page.byteLength), ANY)),
    ).toBe('X_STORAGE_TYPE_REJECTED');
    // The same cut in a WHOLE object is a bad sequence: only a head gets the benefit of the doubt.
    expect(sniffContentType(head)).toBeUndefined();
    expect(codeOf(() => validateStoredHead(headOf(head, 'application/xml'), ANY))).toBe(
      'X_STORAGE_TYPE_REJECTED',
    );
  });

  test('a bad sequence before the window’s end is still a bad sequence', () => {
    const head = new Uint8Array([...bytesOf('<a>'), 0xff, ...bytesOf('</a>')]);
    expect(
      codeOf(() => validateStoredHead(headOf(head, 'application/xml', head.byteLength + 10), ANY)),
    ).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('XML over the window is refused: a script can sit anywhere in it', () => {
    const head = bytesOf('<a>data</a>');
    const size = SNIFF_WINDOW_BYTES + 1;
    for (const type of ['application/xml', 'image/svg+xml']) {
      expect(codeOf(() => validateStoredHead(headOf(head, type, size), ANY))).toBe(
        'X_STORAGE_TYPE_REJECTED',
      );
    }
    // The same document, whole, is just a document.
    expect(validateStoredHead(headOf(head, 'application/xml'), ANY).contentType).toBe(
      'application/xml',
    );
    // And a plain text type over the window is not XML: nothing runs it.
    expect(validateStoredHead(headOf(head, 'text/plain', size), ANY).contentType).toBe(
      'text/plain',
    );
  });
});
