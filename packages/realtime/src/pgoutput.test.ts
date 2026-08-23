import { describe, expect, test } from 'bun:test';
import { ReplicationProtocolError } from './errors';
import { ByteWriter, epochMsToPgTimestamp } from './pg-bytes';
import { PgOutputDecoder } from './pgoutput';

// Byte-payload builders: mirror the wire tables in the pgoutput spec so the tests below read as
// intent ("an Insert with these columns"), not as hex dumps a reader would have to re-derive.

const tagByte = (char: string): number => char.charCodeAt(0);
const textEncoder = new TextEncoder();

interface ColumnSpec {
  readonly name: string;
  readonly typeOid: number;
  readonly typeMod?: number;
  readonly key?: boolean;
}

function relationPayload(spec: {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly replicaIdentity?: string;
  readonly columns: readonly ColumnSpec[];
}): Uint8Array {
  const writer = new ByteWriter()
    .uint8(tagByte('R'))
    .int32(spec.oid)
    .cstring(spec.schema)
    .cstring(spec.name)
    .uint8(tagByte(spec.replicaIdentity ?? 'd'))
    .int16(spec.columns.length);
  for (const column of spec.columns) {
    writer
      .uint8(column.key ? 1 : 0)
      .cstring(column.name)
      .int32(column.typeOid)
      .int32(column.typeMod ?? -1);
  }
  return writer.finish();
}

type TupleColumn =
  | { readonly kind: 'n' }
  | { readonly kind: 'u' }
  | { readonly kind: 't'; readonly text: string }
  | { readonly kind: 'b'; readonly bytes: Uint8Array };

function writeTupleData(writer: ByteWriter, columns: readonly TupleColumn[]): void {
  writer.int16(columns.length);
  for (const column of columns) {
    if (column.kind === 'n' || column.kind === 'u') {
      writer.uint8(tagByte(column.kind));
      continue;
    }
    if (column.kind === 't') {
      const bytes = textEncoder.encode(column.text);
      writer.uint8(tagByte('t')).int32(bytes.length).raw(bytes);
      continue;
    }
    writer.uint8(tagByte('b')).int32(column.bytes.length).raw(column.bytes);
  }
}

function insertPayload(relationOid: number, after: readonly TupleColumn[]): Uint8Array {
  const writer = new ByteWriter().uint8(tagByte('I')).int32(relationOid).uint8(tagByte('N'));
  writeTupleData(writer, after);
  return writer.finish();
}

function updatePayload(
  relationOid: number,
  after: readonly TupleColumn[],
  before?: { readonly marker: 'K' | 'O'; readonly columns: readonly TupleColumn[] },
): Uint8Array {
  const writer = new ByteWriter().uint8(tagByte('U')).int32(relationOid);
  if (before) {
    writer.uint8(tagByte(before.marker));
    writeTupleData(writer, before.columns);
  }
  writer.uint8(tagByte('N'));
  writeTupleData(writer, after);
  return writer.finish();
}

function deletePayload(
  relationOid: number,
  marker: 'K' | 'O',
  before: readonly TupleColumn[],
): Uint8Array {
  const writer = new ByteWriter().uint8(tagByte('D')).int32(relationOid).uint8(tagByte(marker));
  writeTupleData(writer, before);
  return writer.finish();
}

function beginPayload(commitLsn: bigint, commitMicros: bigint, xid: number): Uint8Array {
  return new ByteWriter()
    .uint8(tagByte('B'))
    .int64(commitLsn)
    .int64(commitMicros)
    .int32(xid)
    .finish();
}

function commitPayload(commitLsn: bigint, endLsn: bigint, commitMicros: bigint): Uint8Array {
  return new ByteWriter()
    .uint8(tagByte('C'))
    .uint8(0)
    .int64(commitLsn)
    .int64(endLsn)
    .int64(commitMicros)
    .finish();
}

function truncatePayload(oids: readonly number[]): Uint8Array {
  const writer = new ByteWriter().uint8(tagByte('T')).int32(oids.length).uint8(0);
  for (const oid of oids) writer.int32(oid);
  return writer.finish();
}

describe('Relation + Insert', () => {
  test('decodes the right table, columns, and typed values', () => {
    const decoder = new PgOutputDecoder();
    const columns: ColumnSpec[] = [
      { name: 'id', typeOid: 23, key: true },
      { name: 'active', typeOid: 16 },
      { name: 'big_number', typeOid: 20 },
      { name: 'amount', typeOid: 1700 },
      { name: 'meta', typeOid: 3802 },
      { name: 'created_at', typeOid: 1184 },
      { name: 'note', typeOid: 25 },
    ];

    const relationMessage = decoder.decode(
      relationPayload({ oid: 100, schema: 'public', name: 'widgets', columns }),
    );
    expect(relationMessage.kind).toBe('relation');
    if (relationMessage.kind !== 'relation') return;
    expect(relationMessage.relation.schema).toBe('public');
    expect(relationMessage.relation.name).toBe('widgets');
    expect(relationMessage.relation.columns.map((c) => c.name)).toEqual([
      'id',
      'active',
      'big_number',
      'amount',
      'meta',
      'created_at',
      'note',
    ]);
    expect(relationMessage.relation.columns.map((c) => c.typeOid)).toEqual([
      23, 16, 20, 1700, 3802, 1184, 25,
    ]);
    expect(relationMessage.relation.columns[0]?.key).toBe(true);
    expect(relationMessage.relation.columns[1]?.key).toBe(false);

    const insertMessage = decoder.decode(
      insertPayload(100, [
        { kind: 't', text: '42' },
        { kind: 't', text: 't' },
        { kind: 't', text: '9223372036854775807' },
        { kind: 't', text: '12345.6789' },
        { kind: 't', text: '{"a":1,"b":[true,null]}' },
        { kind: 't', text: '2026-08-09T12:00:00+00:00' },
        { kind: 'n' },
      ]),
    );
    expect(insertMessage.kind).toBe('insert');
    if (insertMessage.kind !== 'insert') return;
    expect(insertMessage.relation.name).toBe('widgets');
    expect(insertMessage.after).toEqual({
      id: 42,
      active: true,
      big_number: '9223372036854775807',
      amount: '12345.6789',
      meta: { a: 1, b: [true, null] },
      // A `Date`, not the text postgres wrote: `timestamp()` reads back as one through the
      // repository, and a live row that is not a repository row is what `pg-values.ts` exists for.
      created_at: new Date('2026-08-09T12:00:00.000Z'),
      note: null,
    });
    expect('note' in insertMessage.after).toBe(true);
  });
});

describe('Update', () => {
  const columns: ColumnSpec[] = [
    { name: 'id', typeOid: 23, key: true },
    { name: 'name', typeOid: 25 },
  ];

  function decoderWithRelation(oid: number): PgOutputDecoder {
    const decoder = new PgOutputDecoder();
    decoder.decode(relationPayload({ oid, schema: 'public', name: 'items', columns }));
    return decoder;
  }

  test('an "O" old tuple yields both before and after', () => {
    const decoder = decoderWithRelation(200);
    const message = decoder.decode(
      updatePayload(
        200,
        [
          { kind: 't', text: '1' },
          { kind: 't', text: 'new-name' },
        ],
        {
          marker: 'O',
          columns: [
            { kind: 't', text: '1' },
            { kind: 't', text: 'old-name' },
          ],
        },
      ),
    );
    expect(message.kind).toBe('update');
    if (message.kind !== 'update') return;
    expect(message.before).toEqual({ id: 1, name: 'old-name' });
    expect(message.after).toEqual({ id: 1, name: 'new-name' });
  });

  test('no old-tuple section yields before: null', () => {
    const decoder = decoderWithRelation(201);
    const message = decoder.decode(
      updatePayload(201, [
        { kind: 't', text: '1' },
        { kind: 't', text: 'new-name' },
      ]),
    );
    expect(message.kind).toBe('update');
    if (message.kind !== 'update') return;
    expect(message.before).toBeNull();
    expect(message.after).toEqual({ id: 1, name: 'new-name' });
  });

  test('a "K" key tuple yields only the key columns as before', () => {
    const decoder = decoderWithRelation(202);
    const message = decoder.decode(
      updatePayload(
        202,
        [
          { kind: 't', text: '1' },
          { kind: 't', text: 'new-name' },
        ],
        { marker: 'K', columns: [{ kind: 't', text: '1' }, { kind: 'u' }] },
      ),
    );
    expect(message.kind).toBe('update');
    if (message.kind !== 'update') return;
    expect(message.before).toEqual({ id: 1 });
    expect(message.before !== null && 'name' in message.before).toBe(false);
  });
});

test('a Delete yields before', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 300,
      schema: 'public',
      name: 'items',
      columns: [
        { name: 'id', typeOid: 23, key: true },
        { name: 'name', typeOid: 25 },
      ],
    }),
  );
  const message = decoder.decode(
    deletePayload(300, 'K', [{ kind: 't', text: '9' }, { kind: 'u' }]),
  );
  expect(message.kind).toBe('delete');
  if (message.kind !== 'delete') return;
  expect(message.before).toEqual({ id: 9 });
  expect('name' in message.before).toBe(false);
});

test('an unchanged-TOAST column is absent, distinguishable from an explicit null', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 400,
      schema: 'public',
      name: 'docs',
      columns: [
        { name: 'id', typeOid: 23, key: true },
        { name: 'body', typeOid: 25 },
        { name: 'summary', typeOid: 25 },
      ],
    }),
  );
  const message = decoder.decode(
    insertPayload(400, [{ kind: 't', text: '1' }, { kind: 'u' }, { kind: 'n' }]),
  );
  expect(message.kind).toBe('insert');
  if (message.kind !== 'insert') return;
  expect('body' in message.after).toBe(false);
  expect('summary' in message.after).toBe(true);
  expect(message.after['summary']).toBeNull();
});

test('a re-sent Relation with the same oid replaces the cache', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 500,
      schema: 'public',
      name: 'things',
      columns: [
        { name: 'id', typeOid: 23, key: true },
        { name: 'old_col', typeOid: 25 },
      ],
    }),
  );
  decoder.decode(
    relationPayload({
      oid: 500,
      schema: 'public',
      name: 'things',
      columns: [
        { name: 'id', typeOid: 23, key: true },
        { name: 'new_col', typeOid: 25 },
      ],
    }),
  );

  const message = decoder.decode(
    insertPayload(500, [
      { kind: 't', text: '1' },
      { kind: 't', text: 'hi' },
    ]),
  );
  expect(message.kind).toBe('insert');
  if (message.kind !== 'insert') return;
  expect(message.after).toEqual({ id: 1, new_col: 'hi' });
  expect('old_col' in message.after).toBe(false);
  expect(decoder.relation(500)?.columns.map((c) => c.name)).toEqual(['id', 'new_col']);
});

test('a tuple for an unknown oid throws X_REPLICATION_PROTOCOL', () => {
  const decoder = new PgOutputDecoder();
  expect(() => decoder.decode(insertPayload(9999, [{ kind: 't', text: '1' }]))).toThrow(
    ReplicationProtocolError,
  );
});

test('a tuple whose column count disagrees with the relation throws', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 600,
      schema: 'public',
      name: 'pairs',
      columns: [
        { name: 'id', typeOid: 23, key: true },
        { name: 'name', typeOid: 25 },
      ],
    }),
  );
  expect(() =>
    decoder.decode(
      insertPayload(600, [
        { kind: 't', text: '1' },
        { kind: 't', text: 'x' },
        { kind: 't', text: 'extra' },
      ]),
    ),
  ).toThrow(ReplicationProtocolError);
});

test('Begin and Commit carry lsn and an epoch-ms timestamp', () => {
  const decoder = new PgOutputDecoder();
  const at = Date.UTC(2026, 7, 9, 12, 0, 0);
  const micros = epochMsToPgTimestamp(at);

  const begin = decoder.decode(beginPayload(0x16b3748n, micros, 42));
  expect(begin.kind).toBe('begin');
  if (begin.kind !== 'begin') return;
  expect(begin.commitLsn).toBe(0x16b3748n);
  expect(begin.commitAt).toBe(at);
  expect(begin.xid).toBe(42);

  const commit = decoder.decode(commitPayload(0x16b3748n, 0x16b3800n, micros));
  expect(commit.kind).toBe('commit');
  if (commit.kind !== 'commit') return;
  expect(commit.commitLsn).toBe(0x16b3748n);
  expect(commit.endLsn).toBe(0x16b3800n);
  expect(commit.commitAt).toBe(at);
});

test('an unknown message tag yields "other" rather than throwing', () => {
  const decoder = new PgOutputDecoder();
  for (const tag of ['O', 'Y', 'M', 'Z']) {
    const payload = new ByteWriter()
      .uint8(tagByte(tag))
      .raw(new Uint8Array([1, 2, 3]))
      .finish();
    expect(decoder.decode(payload)).toEqual({ kind: 'other', tag });
  }
});

test('Truncate resolves cached oids and skips unknown ones', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 700,
      schema: 'public',
      name: 'known',
      columns: [{ name: 'id', typeOid: 23, key: true }],
    }),
  );
  const message = decoder.decode(truncatePayload([700, 999]));
  expect(message.kind).toBe('truncate');
  if (message.kind !== 'truncate') return;
  expect(message.relations).toHaveLength(1);
  expect(message.relations[0]?.oid).toBe(700);
});

test('a binary column throws — we never request binary', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(
    relationPayload({
      oid: 800,
      schema: 'public',
      name: 'bin',
      columns: [{ name: 'id', typeOid: 23, key: true }],
    }),
  );
  expect(() =>
    decoder.decode(insertPayload(800, [{ kind: 'b', bytes: new Uint8Array([1, 2, 3, 4]) }])),
  ).toThrow(ReplicationProtocolError);
});
