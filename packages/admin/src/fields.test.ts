// The column-kind table is the admin's only opinion about how a column renders, so every live
// ColumnKind is accounted for here: mapped to a widget that round-trips the row value the column
// actually produces, or refused at derive time with the escape hatch its fix names.

import { describe, expect, test } from 'bun:test';
import type { ColumnKind } from '@ultimat3/entity';
import { bigint } from '@ultimat3/entity';
import type { AdminColumnFacts } from './entity-columns';
import type { AdminField, AdminFieldType } from './fields';
import { fieldTypeFromColumn, listable, searchable, widgetFor } from './fields';
import type { WidgetContext } from './widget-value';
import { widgetProps } from './widget-value';

const facts = (kind: string, over: Partial<AdminColumnFacts> = {}): AdminColumnFacts => ({
  name: 'value',
  kind,
  nullable: false,
  primaryKey: false,
  unique: false,
  index: false,
  generated: false,
  ...over,
});

const typeOf = (kind: string): AdminFieldType => fieldTypeFromColumn('rates', 'value', facts(kind));

const fieldOf = (kind: string): AdminField => {
  const column = facts(kind);
  const type = fieldTypeFromColumn('rates', 'value', column);
  return {
    entity: 'rates',
    name: 'value',
    type,
    widget: widgetFor(type),
    labelKey: 'admin.rates.field.value',
    required: true,
    readOnly: false,
    sensitive: false,
    inList: listable(type),
    filterable: false,
    sortable: false,
    searchable: searchable(type, column),
  };
};

const ctx: WidgetContext = { timeZone: 'UTC', locale: 'en-US' };

/**
 * Every kind `@ultimat3/entity` can put on a column, and what the admin answers for it. Typed as a
 * TOTAL record over `ColumnKind`, so a new column builder is a type error in this file rather than
 * an `X_ADMIN_FIELD_UNSUPPORTED` in the first dashboard that renders the column.
 */
const EVERY_KIND: Readonly<Record<ColumnKind, AdminFieldType | 'refused'>> = {
  uuid: 'text',
  text: 'textarea',
  char: 'text',
  boolean: 'boolean',
  integer: 'number',
  bigint: 'text',
  numeric: 'text',
  timestamptz: 'timestamptz',
  date: 'date',
  jsonb: 'json',
  bytea: 'refused',
  array: 'json',
  money: 'money',
};

describe('unit · every column kind is answered', () => {
  test('a mapped kind resolves to its field type and a widget that exists', () => {
    for (const [kind, expected] of Object.entries(EVERY_KIND)) {
      if (expected === 'refused') continue;
      expect([kind, typeOf(kind)]).toEqual([kind, expected]);
      expect(widgetFor(expected)).toBeString();
    }
  });

  test('a refused kind still names the code, the kind and the escape hatch', () => {
    for (const [kind, expected] of Object.entries(EVERY_KIND)) {
      if (expected !== 'refused') continue;
      let thrown: unknown;
      try {
        typeOf(kind);
      } catch (error: unknown) {
        thrown = error;
      }
      const error = thrown as { code?: string; cause?: string; fix?: string } | undefined;
      expect(error?.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(error?.cause).toContain(kind);
      expect(error?.fix).toContain('hidden: true');
    }
  });
});

describe('unit · the kinds an existing schema brings', () => {
  // `decimal()`'s row type is the exact decimal STRING Postgres returned — the whole reason it is
  // not a number. A `number-input` renders anything that is not a JS number as null, which would
  // blank the field and write that blank back on the next save.
  test('numeric renders its digits verbatim, never through the number widget', () => {
    expect(typeOf('numeric')).toBe('text');
    const props = widgetProps(fieldOf('numeric'), '1234.56780000', ctx);
    expect(props).toEqual({ widget: 'text-input', field: 'value', value: '1234.56780000' });
  });

  // `bigint()`'s row type is a decimal STRING — a JS bigint is what `JSON.stringify` throws on,
  // and a number loses digits past 2^53, which is precisely the range a legacy `int8` key lives
  // in. `number-input` renders anything that is not a JS number as null, so the mapping this
  // replaced blanked the field and saved the blank back over the id.
  test('a bigint past 2^53 survives render → edit → save with every digit', () => {
    expect(typeOf('bigint')).toBe('text');
    // 2^53 + 1: the first integer a JS number cannot represent.
    const stored = '9007199254740993';
    const props = widgetProps(fieldOf('bigint'), stored, ctx);
    expect(props).toEqual({ widget: 'text-input', field: 'value', value: stored });
    // The round trip closed against the column itself: what the control posts back is what
    // `bigint()` accepts, unchanged. `Number(stored)` would be 9007199254740992 here.
    const posted = props.widget === 'text-input' ? props.value : '';
    expect(bigint().$parse(posted)).toBe(stored);
  });

  // `date()` is a calendar date with no zone, and `precision: 'date'` is the branch the datetime
  // widget already carries for exactly that: `<input type="date">`, valued `YYYY-MM-DD`.
  test('date reaches the date control with the calendar date it stored', () => {
    expect(typeOf('date')).toBe('date');
    expect(widgetProps(fieldOf('date'), '2026-08-18', ctx)).toEqual({
      widget: 'datetime',
      field: 'value',
      value: '2026-08-18',
      timeZone: 'UTC',
      precision: 'date',
    });
  });

  // `String(['a,b'])` and `String(['a', 'b'])` are the same string, so a text input cannot say
  // which array it was handed — and the value it posts back is not an array at all. The JSON
  // editor round-trips both exactly.
  test('array round-trips as JSON rather than being flattened into a text input', () => {
    expect(typeOf('array')).toBe('json');
    expect(widgetProps(fieldOf('array'), ['a,b'], ctx)).toEqual({
      widget: 'json-editor',
      field: 'value',
      value: '[\n  "a,b"\n]',
    });
  });

  test('an array is never a search target — `contains` on a column of arrays is not a LIKE', () => {
    expect(searchable(typeOf('array'), facts('array'))).toBe(false);
    expect(listable(typeOf('array'))).toBe(false);
  });

  /**
   * The kinds that render in a text box and cannot be searched. `uuid` is the one that predates
   * this sweep: `uuid: 'text'` shipped searchable, and Postgres refuses `LIKE` on a uuid column
   * exactly as it does on the other two — measured, see `LIKE_ABLE_COLUMN_KINDS`.
   */
  test('a text BOX is not a text COLUMN: only kinds that take a LIKE are searched', () => {
    for (const kind of ['uuid', 'numeric', 'bigint']) {
      expect([kind, searchable(typeOf(kind), facts(kind))]).toEqual([kind, false]);
    }
    for (const kind of ['text', 'char']) {
      expect([kind, searchable(typeOf(kind), facts(kind))]).toEqual([kind, true]);
    }
  });

  // WHY `bytea` is refused rather than mapped to `file`: the upload widget's value is a storage
  // REFERENCE, and the bytes a `bytes()` column puts on the row are not one. Mapping it would
  // move the same failure from derive time — where the fix names the edit — to every render.
  test('the file widget cannot take raw bytes, which is why bytea stays unmapped', () => {
    const asFile: AdminField = { ...fieldOf('jsonb'), type: 'file', widget: 'upload' };
    expect(() => widgetProps(asFile, new Uint8Array([1, 2, 3]), ctx)).toThrow(
      /file value has no url/,
    );
  });
});
