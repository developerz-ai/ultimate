// Property: the pgoutput decoder reads back any Relation + Insert a correct encoder writes —
// hostile column names and multibyte values included — and no bytes off the wire make it throw
// anything but its own coded `X_REPLICATION_PROTOCOL` — nor decode, silently, a frame whose
// lengths are negative or which runs past the message it frames.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
// Relative: the decoder is not public API, and a test never ships (`registry-snapshot.test.ts`).
import { ByteWriter } from '../../realtime/src/pg-bytes';
import { insert } from '../../realtime/src/pg-replication-fixture';
import { PgOutputDecoder } from '../../realtime/src/pgoutput';
import { property } from './property';
import { gen } from './property-gen';

const TEXT_OID = 25;
const OID = 16_384;
const NAME_CHARS = ['a', 'Z', '_', ' ', '"', 'é', '漢', '🙂', '_'] as const;

const relationFrame = (names: readonly string[]): Uint8Array => {
  const writer = new ByteWriter()
    .uint8(0x52)
    .int32(OID)
    .cstring('public')
    .cstring('t')
    .uint8(0x66)
    .int16(names.length);
  for (const name of names) writer.uint8(0).cstring(name).int32(TEXT_OID).int32(-1);
  return writer.finish();
};

/** As Postgres frames it: the length is the value's UTF-8 BYTE count. */
const insertFrame = (values: readonly (string | null)[]): Uint8Array => {
  const writer = new ByteWriter().uint8(0x49).int32(OID).uint8(0x4e).int16(values.length);
  for (const value of values) {
    if (value === null) writer.uint8(0x6e);
    else {
      const bytes = new TextEncoder().encode(value);
      writer.uint8(0x74).int32(bytes.length).raw(bytes);
    }
  }
  return writer.finish();
};

const row = gen.array(
  gen.tuple(
    gen.string({ minLength: 1, maxLength: 6, chars: gen.oneOf(NAME_CHARS) }),
    gen.union([gen.constant(null), gen.string({ maxLength: 20 })]),
  ),
  { minLength: 1, maxLength: 6 },
);

describe('pgoutput decoder properties', () => {
  test('decode(insert(values)) is the values, under any column names', () => {
    property(
      row,
      (columns) => {
        const names = columns.map(([name], at) => `${at}${name}`);
        const values = columns.map(([, value]) => value);
        const decoder = new PgOutputDecoder();
        decoder.decode(relationFrame(names));
        const message = decoder.decode(insertFrame(values));
        if (message.kind !== 'insert') return expect.unreachable(`decoded a ${message.kind}`);
        expect({ ...message.after }).toEqual(
          Object.fromEntries(columns.map(([name, value], at) => [`${at}${name}`, value])),
        );
      },
      { runs: 400 },
    );
  });

  test('bytes off the wire throw only X_REPLICATION_PROTOCOL', () => {
    const tag = gen.oneOf([0x49, 0x55, 0x44, 0x52, 0x54, 0x4d, 0x42, 0x43]);
    property(
      gen.tuple(tag, gen.bytes({ maxLength: 48 })),
      ([first, rest]) => {
        const decoder = new PgOutputDecoder();
        decoder.decode(relationFrame(['id', 'body']));
        try {
          decoder.decode(Uint8Array.from([first, ...rest]));
        } catch (error) {
          expect(isUltimateError(error) && error.code).toBe('X_REPLICATION_PROTOCOL');
        }
      },
      { runs: 1_000 },
    );
  });
  /** Throws, and only `X_REPLICATION_PROTOCOL`: a decode that returns is the silent misread. */
  const refused = (frame: Uint8Array): void => {
    const decoder = new PgOutputDecoder();
    decoder.decode(relationFrame(['id', 'body']));
    let caught: unknown;
    try {
      decoder.decode(frame);
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_REPLICATION_PROTOCOL');
  };

  test('a negative value length is refused, never a cursor moved backwards', () => {
    property(
      gen.tuple(gen.int(-64, -2), gen.bytes({ minLength: 0, maxLength: 24 })),
      ([length, tail]) => {
        const writer = new ByteWriter().uint8(0x49).int32(OID).uint8(0x4e).int16(2);
        writer.uint8(0x74).int32(length).raw(tail);
        refused(writer.finish());
      },
      { runs: 300 },
    );
  });

  test('bytes after a message whose format fixes its length are refused', () => {
    property(
      gen.tuple(gen.string({ maxLength: 12 }), gen.bytes({ minLength: 1, maxLength: 16 })),
      ([body, extra]) => {
        const frame = insertFrame(['1', body]);
        refused(Uint8Array.from([...frame, ...extra]));
      },
      { runs: 300 },
    );
  });

  test("the replication fixture's insert() frames a value by its UTF-8 byte length", () => {
    property(
      gen.string({ maxLength: 20 }),
      (body) => {
        const decoder = new PgOutputDecoder();
        decoder.decode(relationFrame(['id', 'body']));
        const message = decoder.decode(insert(OID, ['1', body]));
        if (message.kind !== 'insert') return expect.unreachable(`decoded a ${message.kind}`);
        expect(message.after['body']).toBe(body);
      },
      { runs: 300 },
    );
  });
});
