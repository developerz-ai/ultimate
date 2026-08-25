// The bytes an export artifact is made of. Pure, so every hazard here is testable without a queue:
// a cell that would execute in a spreadsheet, a cell that would break the row it sits in, a value
// that would land in the file as the word `NaN`, and a `row()` that answers different keys than the
// declaration promised.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { EXPORT_EXTENSION, EXPORT_FORMATS, encodeExportPage } from './export-format';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const COLUMNS = ['id', 'title', 'total', 'archived'] as const;

const page = (
  records: readonly Readonly<Record<string, string | number | boolean | null>>[],
  over: { format?: 'ndjson' | 'csv'; header?: boolean } = {},
): string =>
  text(
    encodeExportPage({
      subject: 'orders',
      format: over.format ?? 'csv',
      columns: [...COLUMNS],
      records,
      header: over.header ?? false,
    }),
  );

describe('the format vocabulary', () => {
  test('is two formats with an extension each', () => {
    expect([...EXPORT_FORMATS]).toEqual(['ndjson', 'csv']);
    expect(EXPORT_EXTENSION.ndjson).toBe('ndjson');
    expect(EXPORT_EXTENSION.csv).toBe('csv');
  });
});

describe('ndjson', () => {
  test('one JSON object per line, in the declared column order', () => {
    const out = page([{ total: 100, id: 'a', archived: false, title: 'One' }], {
      format: 'ndjson',
    });
    expect(out).toBe('{"id":"a","title":"One","total":100,"archived":false}\n');
  });

  test('every line ends in a newline, so two parts concatenate into one valid file', () => {
    const out = page(
      [
        { id: 'a', title: 'One', total: 1, archived: false },
        { id: 'b', title: 'Two', total: 2, archived: true },
      ],
      { format: 'ndjson' },
    );
    expect(out.endsWith('\n')).toBe(true);
    expect(out.split('\n').filter((line) => line !== '')).toHaveLength(2);
  });

  test('a newline inside a value can never break the line framing', () => {
    const out = page([{ id: 'a', title: 'One\nTwo', total: 1, archived: false }], {
      format: 'ndjson',
    });
    expect(out.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });
});

describe('csv', () => {
  test('the header is written only when it is asked for', () => {
    const rows = [{ id: 'a', title: 'One', total: 1, archived: false }];
    expect(page(rows, { header: true })).toBe('id,title,total,archived\na,One,1,false\n');
    expect(page(rows)).toBe('a,One,1,false\n');
  });

  test('a separator, a quote or a newline in a value is quoted rather than emitted raw', () => {
    const out = page([{ id: 'a', title: 'One,"Two"\nThree', total: 1, archived: false }]);
    expect(out).toBe('a,"One,""Two""\nThree",1,false\n');
  });

  test('a null is an empty cell and never the word null', () => {
    expect(page([{ id: 'a', title: null, total: 0, archived: false }])).toBe('a,,0,false\n');
  });

  test('a cell a spreadsheet would EXECUTE is neutralised', () => {
    // The whole reason this format is the framework's and not each app's. Excel, Sheets and
    // LibreOffice all evaluate a cell beginning `=`, `+`, `-`, `@`, TAB or CR — so an app that
    // lets a user name a record `=cmd|'/c calc'!A1` has written a remote-code-execution export
    // and nothing in its own code looks wrong.
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const out = page([{ id: 'a', title: `${lead}HYPERLINK("x")`, total: 1, archived: false }]);
      expect(out).toContain(`'${lead}`);
    }
  });

  test('a negative NUMBER is still a negative number', () => {
    // The guard is on strings only. Prefixing every leading `-` would turn a refund column into
    // text in every spreadsheet that opens it.
    expect(page([{ id: 'a', title: 'One', total: -250, archived: false }])).toBe(
      'a,One,-250,false\n',
    );
  });
});

describe('a row the declaration did not promise is refused', () => {
  const codeOf = (record: Readonly<Record<string, unknown>>): string => {
    try {
      page([record as Readonly<Record<string, string | number | boolean | null>>]);
    } catch (error) {
      return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
    }
    return 'encoded';
  };

  test('a missing column', () => {
    expect(codeOf({ id: 'a', title: 'One', total: 1 })).toBe('X_EXPORT_ROW_INVALID');
  });

  test('a column nobody declared, which would otherwise be dropped in silence', () => {
    expect(codeOf({ id: 'a', title: 'One', total: 1, archived: false, secretPii: 'x' })).toBe(
      'X_EXPORT_ROW_INVALID',
    );
  });

  test('a value that is not exportable', () => {
    for (const total of [Number.NaN, Number.POSITIVE_INFINITY, {}, [], undefined]) {
      expect(codeOf({ id: 'a', title: 'One', total, archived: false })).toBe(
        'X_EXPORT_ROW_INVALID',
      );
    }
  });

  test('the refusal names the column and never the value', () => {
    let thrown: unknown;
    try {
      page([{ id: 'a', title: 'One', total: Number.NaN, archived: false }]);
    } catch (error) {
      thrown = error;
    }
    if (!isUltimateError(thrown)) return expect.unreachable('expected an UltimateError');
    expect(thrown.cause).toContain('total');
    // A cell is user data by definition; a refusal reaches the log store as an unredactable field.
    expect(thrown.cause).not.toContain('One');
  });
});
