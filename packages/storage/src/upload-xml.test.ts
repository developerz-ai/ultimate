// An xhtml-namespaced body is not accepted as application/xml, and the upload ceiling is screened
// where it is declared — an explicit null refused, never defaulted. Split from upload.test.ts.

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

/**
 * An XML document is not inert because it is XML: a browser rendering `application/xml` executes
 * an XHTML-namespaced `<script>` anywhere in it, an SVG-namespaced element likewise, and an
 * `<?xml-stylesheet?>` turns the document into whatever HTML its XSLT emits. Sniffed as plain
 * text, every one of them was accepted under `application/xml` or `text/xml`.
 */
describe('xhtml-namespaced xml is not accepted as application/xml', () => {
  const XML = uploadPolicy({ allowedContentTypes: ['application/xml', 'text/xml'] });
  const upload = (body: string, declaredContentType = 'application/xml') =>
    codeOf(() =>
      validateUpload({ key: 'a/data.xml', declaredContentType, bytes: bytesOf(body) }, XML),
    );

  test.each([
    [
      'an xhtml root',
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
    ],
    [
      'an xhtml element deep inside a data document',
      `<?xml version="1.0"?><order>${'<line/>'.repeat(200)}<x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script></order>`,
    ],
    [
      'the namespace spelled with character references',
      '<doc><script xmlns="http&#58;//www.w3.org/1999/&#x78;html">alert(1)</script></doc>',
    ],
    [
      'an xslt stylesheet instruction',
      '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="/x.xsl"?><a/>',
    ],
    [
      'an internal entity subset, which can assemble a namespace no scan sees',
      '<!DOCTYPE d [<!ENTITY a "http://www.w3.org/1999/">]><d xmlns:h="&a;xhtml"/>',
    ],
  ])('%s is refused', (_label, body) => {
    expect(upload(body)).toBe('X_STORAGE_TYPE_REJECTED');
    expect(upload(body, 'text/xml')).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('an svg-namespaced element past the first 512 bytes sniffs as svg', () => {
    const body = `<?xml version="1.0"?><feed>${' '.repeat(600)}<s:svg xmlns:s="http://www.w3.org/2000/svg" onload="alert(1)"/></feed>`;
    expect(sniffContentType(bytesOf(body))).toBe('image/svg+xml');
    expect(upload(body)).toBe('X_STORAGE_TYPE_REJECTED');
  });

  // Zero padding is legal in an XML character reference and a browser decodes it, so a scan that
  // capped the digit count read `&#x000000003a;` as text while the parser read `:`.
  test.each([
    [
      'hex',
      '<doc><script xmlns="http&#x000000003a;//www.w3.org/1999/xhtml">alert(1)</script></doc>',
    ],
    [
      'decimal',
      '<doc><script xmlns="http&#00000000058;//www.w3.org/1999/xhtml">alert(1)</script></doc>',
    ],
  ])('a zero-padded %s character reference cannot hide the namespace', (_label, body) => {
    expect(sniffContentType(bytesOf(body))).toBe('text/html');
    expect(upload(body)).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('an out-of-range character reference is left as written, not decoded', () => {
    const body = '<doc a="&#x110000;&#99999999999999999999;"/>';
    expect(sniffContentType(bytesOf(body))).toBe('text/plain');
  });

  // A body the sniffer cannot read is not a body it cleared: under an XML type a browser picks
  // the encoding from a BOM or the declaration and runs whatever it decodes.
  const utf16 = (text: string, littleEndian: boolean): Uint8Array => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      out[2 + index * 2] = littleEndian ? code & 0xff : code >> 8;
      out[3 + index * 2] = littleEndian ? code >> 8 : code & 0xff;
    }
    return out;
  };
  const PAGE = '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>';

  test('the refusal says the bytes are not UTF-8 text, never that a signature is missing', () => {
    const thrown = (() => {
      try {
        validateUpload(
          { key: 'a/data.xml', declaredContentType: 'application/xml', bytes: utf16(PAGE, true) },
          XML,
        );
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    if (!isStorageError(thrown)) expect.unreachable('an unreadable XML body was accepted');
    expect(thrown.code).toBe('X_STORAGE_TYPE_REJECTED');
    expect(thrown.cause).toContain('not readable UTF-8 text');
    expect(thrown.cause).not.toContain('signature');
    expect(thrown.fix.startsWith('validateUpload({ key: "a/data.xml"')).toBe(true);
  });

  test.each([
    ['UTF-16LE with a BOM', utf16(PAGE, true)],
    ['UTF-16BE with a BOM', utf16(PAGE, false)],
    ['one control byte', new Uint8Array([...bytesOf(PAGE), 0x01])],
    [
      'one byte that is not UTF-8',
      new Uint8Array([...bytesOf(`<?xml version="1.0" encoding="windows-1252"?>${PAGE}`), 0xe9]),
    ],
  ])('a body the sniffer cannot classify (%s) is refused under every XML type', (_label, bytes) => {
    expect(sniffContentType(bytes)).toBeUndefined();
    for (const declaredContentType of ['application/xml', 'text/xml', 'application/rss+xml']) {
      expect(
        codeOf(() =>
          validateUpload(
            { key: 'a/data.xml', declaredContentType, bytes },
            uploadPolicy({ allowedContentTypes: [declaredContentType] }),
          ),
        ),
      ).toBe('X_STORAGE_TYPE_REJECTED');
    }
  });

  test('a plain data document is still accepted as application/xml', () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><invoice xmlns="urn:example:invoice"><total>12</total></invoice>';
    const validated = validateUpload(
      { key: 'a/invoice.xml', declaredContentType: 'application/xml', bytes: bytesOf(body) },
      XML,
    );
    expect(validated.contentType).toBe('application/xml');
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
