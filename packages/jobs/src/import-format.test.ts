// The record boundary an import reads by, on bytes and across windows. Pure, so every hazard is
// testable without a queue: a quoted newline, a character split by a page edge, CRLF, a BOM, an
// escaped quote, an ndjson file with no final newline — and the round trip through the exporter.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { encodeExportPage } from './export-format';
import { fileText } from './import-errors';
import type { RawRecord, SplitInput } from './import-format';
import { parseCsvRecord, readCsvHeader, readImportRecord, splitRecords } from './import-format';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const base: Omit<SplitInput, 'bytes'> = {
  subject: 'people',
  format: 'csv',
  offset: 0,
  line: 1,
  final: true,
  maxRecordBytes: 1_000,
  maxRecords: 1_000,
};

/** The whole file read in windows of `width` bytes, exactly as the pass slices it. */
const readAll = (
  file: Uint8Array,
  width: number,
  over: Partial<SplitInput> = {},
): { records: RawRecord[]; windows: number } => {
  const records: RawRecord[] = [];
  let offset = 0;
  let line = 1;
  let windows = 0;
  while (offset < file.byteLength) {
    const window = file.subarray(offset, Math.min(offset + width, file.byteLength));
    const split = splitRecords({
      ...base,
      ...over,
      bytes: window,
      offset,
      line,
      final: offset + window.byteLength >= file.byteLength,
    });
    records.push(...split.records);
    offset = split.next;
    line = split.nextLine;
    windows += 1;
  }
  return { records, windows };
};

const texts = (records: readonly RawRecord[]): (string | undefined)[] =>
  records.map((record) => record.text);

describe('splitRecords', () => {
  test('a quoted newline is data, and the record after it starts on its real line', () => {
    const { records } = readAll(bytes('a,"one\ntwo"\nb,three\n'), 64);
    expect(texts(records)).toEqual(['a,"one\ntwo"', 'b,three']);
    expect(records.map((record) => record.line)).toEqual([1, 3]);
  });

  test('a quoted newline straddling a window edge is re-read, never split', () => {
    const file = bytes('id,note\n1,"first\nsecond"\n2,plain\n');
    for (let width = 17; width <= file.byteLength; width += 1) {
      const { records } = readAll(file, width, { maxRecordBytes: 16 });
      expect(texts(records)).toEqual(['id,note', '1,"first\nsecond"', '2,plain']);
    }
  });

  test('a multi-byte character cut by the window edge arrives whole', () => {
    const file = bytes('naïve,日本語\n€,🎉\n');
    for (let width = 17; width <= file.byteLength; width += 1) {
      const { records } = readAll(file, width, { maxRecordBytes: 16 });
      expect(texts(records)).toEqual(['naïve,日本語', '€,🎉']);
    }
  });

  test('CRLF and LF read the same, and a blank line is skipped', () => {
    const { records } = readAll(bytes('a,b\r\n\r\nc,d\r\n'), 64);
    expect(texts(records)).toEqual(['a,b', 'c,d']);
  });

  test('a BOM at offset 0 is consumed, and only there', () => {
    const file = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('id\n1\n')]);
    const split = splitRecords({ ...base, bytes: file });
    expect(texts(split.records)).toEqual(['id', '1']);
    const later = splitRecords({ ...base, offset: 9, bytes: file });
    expect(later.records[0]?.text).toBe('\uFEFFid');
  });

  test('a quote inside an unquoted cell opens nothing, as parseCsvRecord reads it', () => {
    // RFC 4180 quotes a FIELD, so a `"` only opens one at a record start or after a comma. Flipping
    // on every quote made `5"` swallow every row after it into one record, lost in silence.
    const { records } = readAll(bytes('a,b\n1,5"\n2,x\n3,y\n'), 64);
    expect(texts(records)).toEqual(['a,b', '1,5"', '2,x', '3,y']);
    const quoted = readAll(bytes('a,"x\ny"\n"p\nq",r\n'), 64);
    expect(texts(quoted.records)).toEqual(['a,"x\ny"', '"p\nq",r']);
  });

  test('an escaped quote does not flip the record boundary', () => {
    const { records } = readAll(bytes('"say ""hi""\nthere",x\ny,z\n'), 64);
    expect(texts(records)).toEqual(['"say ""hi""\nthere",x', 'y,z']);
  });

  test('ndjson takes its short tail at the end of the object, and holds it back before', () => {
    const tail = bytes('{"a":1}\n{"a":2}');
    expect(texts(splitRecords({ ...base, format: 'ndjson', bytes: tail }).records)).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
    const held = splitRecords({ ...base, format: 'ndjson', bytes: tail, final: false });
    expect(texts(held.records)).toEqual(['{"a":1}']);
    expect(held.next).toBe(8);
  });

  test('a quote in ndjson is not a csv quote', () => {
    const file = bytes('{"a":"\\""}\n{"a":2}\n');
    expect(texts(splitRecords({ ...base, format: 'ndjson', bytes: file }).records)).toHaveLength(2);
  });

  test('maxRecords stops the page and names where the next one starts', () => {
    const split = splitRecords({ ...base, bytes: bytes('a\nb\nc\n'), maxRecords: 2 });
    expect(texts(split.records)).toEqual(['a', 'b']);
    expect(split.next).toBe(4);
    expect(split.nextLine).toBe(3);
  });

  test('an unclosed quote is refused at its offset rather than buffered', () => {
    const file = bytes(`ok\n"never closed,${'x'.repeat(40)}\nmore\n`);
    try {
      readAll(file, 32, { maxRecordBytes: 16 });
      expect.unreachable('an unterminated record was buffered');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_IMPORT_RECORD_TOO_LARGE');
      expect(isUltimateError(error) && error.meta).toMatchObject({ offset: 3, maxBytes: 16 });
    }
  });

  test('a complete record past maxRecordBytes is refused even inside one window', () => {
    try {
      splitRecords({ ...base, bytes: bytes(`${'y'.repeat(20)}\n`), maxRecordBytes: 10 });
      expect.unreachable('a record longer than the bound was accepted');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_IMPORT_RECORD_TOO_LARGE');
    }
  });

  test('bytes that are not UTF-8 are one refused record, not a failed file', () => {
    const file = new Uint8Array([...bytes('a\n'), 0xff, 0xfe, ...bytes('\nb\n')]);
    expect(texts(splitRecords({ ...base, bytes: file }).records)).toEqual(['a', undefined, 'b']);
  });
});

describe('parseCsvRecord', () => {
  test('RFC 4180 cells: an empty cell is null, a quoted empty one is the empty string', () => {
    expect(parseCsvRecord('a,,"",b')).toEqual({ cells: ['a', null, '', 'b'] });
    expect(parseCsvRecord('"x, y","he said ""no"""')).toEqual({ cells: ['x, y', 'he said "no"'] });
    expect(parseCsvRecord('a,')).toEqual({ cells: ['a', null] });
  });

  test('a stray or unclosed quote is refused by rule', () => {
    expect(parseCsvRecord('a"b,c')).toEqual({ rejected: 'csv.quote_stray' });
    expect(parseCsvRecord('"a"b,c')).toEqual({ rejected: 'csv.quote_stray' });
    expect(parseCsvRecord('"open,c')).toEqual({ rejected: 'csv.quote_unclosed' });
  });
});

describe('readCsvHeader', () => {
  const header = (text: string) => readCsvHeader('people', ['id', 'name'], { line: 1, text });

  test('answers the file order, so a moved column is still the same file', () => {
    expect(header('name,id')).toEqual(['name', 'id']);
  });

  test('refuses both directions and names both sides', () => {
    try {
      header('id,email');
      expect.unreachable('a renamed column was accepted');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_IMPORT_HEADER_MISMATCH');
      expect(isUltimateError(error) && error.meta).toEqual({
        missing: ['name'],
        undeclaredCount: 1,
        undeclared: ['"email"'],
      });
    }
    expect(() => header('id,name,id')).toThrow(/undeclared column\(s\): "id"/);
  });

  test('a hostile header reaches no cause or fix as raw text', () => {
    // A cell is file content: a newline in it forges a log line, and a 64 KiB cell is a prompt
    // for whichever agent reads `x jobs show`. Escaped, cut short, and only five of them named.
    const forged = `"id\nlevel=error msg=forged ${'x'.repeat(500)}"`;
    const cells = [forged, 'name', ...Array.from({ length: 8 }, (_, n) => `extra${n}`)];
    try {
      header(cells.join(','));
      expect.unreachable('a header naming undeclared columns was accepted');
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
      for (const text of [error.cause, error.fix]) {
        expect(text).not.toContain('\nlevel=error');
        expect(text).not.toContain('x'.repeat(100));
      }
      expect(error.fix).not.toContain('extra');
      expect(error.meta).toMatchObject({ missing: ['id'], undeclaredCount: 9 });
      expect((error.meta as { undeclared: string[] }).undeclared).toHaveLength(5);
    }
  });
});

describe('readImportRecord', () => {
  test('ndjson refuses a key the declaration does not carry, naming the key', () => {
    expect(readImportRecord('ndjson', ['id'], '{"id":1,"ssn":"x"}')).toEqual({
      rejected: 'record.undeclared',
      field: 'ssn',
    });
    // The key is FILE text bound for the error report: cut by the header names' own rule.
    const long = `ssn\n${'k'.repeat(500)}`;
    const refused = readImportRecord('ndjson', ['id'], JSON.stringify({ id: 1, [long]: 'x' }));
    expect(refused).toEqual({ rejected: 'record.undeclared', field: fileText(long) });
    expect(fileText(long)).toHaveLength(41);
    expect(fileText('short')).toBe('short');
    expect(readImportRecord('ndjson', ['id'], '[1]')).toMatchObject({
      rejected: 'json.not_object',
    });
    expect(readImportRecord('ndjson', ['id'], '{')).toMatchObject({ rejected: 'json.syntax' });
  });

  test('csv refuses a row with the wrong number of cells', () => {
    expect(readImportRecord('csv', ['id', 'name'], '1')).toMatchObject({
      rejected: 'csv.field_count',
    });
    expect(readImportRecord('csv', ['id'], undefined)).toMatchObject({ rejected: 'utf8.invalid' });
  });
});

describe('the round trip through encodeExportPage', () => {
  const columns = ['id', 'note', 'score', 'gone'];
  const records = [
    { id: 'a', note: 'comma, "quote"\nnewline', score: 3, gone: null },
    { id: 'b', note: 'ünïcödé 🎉', score: -1.5, gone: true },
  ];

  for (const format of ['csv', 'ndjson'] as const) {
    test(`${format}: what the exporter writes, the importer reads back`, () => {
      const file = encodeExportPage({ subject: 'x', format, columns, records, header: true });
      const { records: raw } = readAll(file, 80, { format, maxRecordBytes: 79 });
      const rows = (format === 'csv' ? raw.slice(1) : raw).map((record) =>
        readImportRecord(format, columns, record.text),
      );
      expect(rows).toEqual(
        format === 'csv'
          ? [
              { record: { id: 'a', note: records[0]?.note, score: '3', gone: null } },
              { record: { id: 'b', note: 'ünïcödé 🎉', score: '-1.5', gone: 'true' } },
            ]
          : records.map((record) => ({ record })),
      );
    });
  }
});
