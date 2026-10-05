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
/**
 * `sniffContentType` answers `undefined` for "no rule recognised it", NEVER for "it is fine" — its
 * own doc says so, and `validateUpload` read it as the second: any body the sniffer bailed on
 * (a control byte, a non-UTF-8 sequence) skipped the guard entirely and was stored under whatever
 * the client declared. Measured: an HTML document with one trailing `0x01` byte was accepted as
 * `image/png` by the function whose whole reason for existing is that Content-Type is
 * attacker-controlled.
 */
describe('an unrecognised body under a type that has a signature', () => {
  const HTML_WITH_CONTROL_BYTE = new Uint8Array([
    ...bytesOf('<html><script>fetch("/steal")</script></html>'),
    0x01,
  ]);

  test('the sniffer itself still answers undefined — that is its contract', () => {
    expect(sniffContentType(HTML_WITH_CONTROL_BYTE)).toBeUndefined();
  });

  test('is refused, not accepted on the declared type', () => {
    const code = codeOf(() =>
      validateUpload(
        {
          key: 'org/org-1/avatars/evil.png',
          declaredContentType: 'image/png',
          bytes: HTML_WITH_CONTROL_BYTE,
        },
        IMAGES,
      ),
    );
    expect(code).toBe('X_STORAGE_TYPE_REJECTED');
  });

  // `upload a genuine image/png file` restated the type the caller had already declared and named
  // no operation at all: a CLI, an MCP tool and an agent each read that as advice, and the error
  // contract's whole point is that a `fix:` is a thing you do. The one remedy is re-running this
  // same validation over different bytes, so the line names the call and the key it is for.
  test('the fix names the call to re-run and the object it is for', () => {
    let thrown: unknown;
    try {
      validateUpload(
        {
          key: 'org/org-1/avatars/evil.png',
          declaredContentType: 'image/png',
          bytes: HTML_WITH_CONTROL_BYTE,
        },
        IMAGES,
      );
    } catch (error) {
      thrown = error;
    }
    const fix = (thrown as { fix: string }).fix;
    expect(fix).toContain('validateUpload(');
    expect(fix).toContain('org/org-1/avatars/evil.png');
    expect(fix).toContain('image/png');
  });

  test('a zip container type is covered too — every OOXML document is a zip', () => {
    const code = codeOf(() =>
      validateUpload(
        {
          key: 'org/org-1/docs/report.docx',
          declaredContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: HTML_WITH_CONTROL_BYTE,
        },
        uploadPolicy({
          allowedContentTypes: [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ],
        }),
      ),
    );
    expect(code).toBe('X_STORAGE_TYPE_REJECTED');
  });

  // The other half, and the reason the rule is "a type that HAS a signature" rather than
  // "anything the sniffer did not recognise": a CSV holding one Latin-1 byte is a real file and
  // no magic rule can ever confirm it.
  test('a declared type no signature can confirm is still accepted', () => {
    const latin1Csv = new Uint8Array([...bytesOf('id,name\n1,caf'), 0xe9, 0x0a]);
    expect(sniffContentType(latin1Csv)).toBeUndefined();
    const result = validateUpload(
      {
        key: 'org/org-1/exports/rows.csv',
        declaredContentType: 'text/csv',
        bytes: latin1Csv,
      },
      uploadPolicy({ allowedContentTypes: ['text/csv'] }),
    );
    expect(result.contentType).toBe('text/csv');
  });
});

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
