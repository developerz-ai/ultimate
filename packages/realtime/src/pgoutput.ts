// Decodes pgoutput logical-replication messages (protocol version 1, Postgres >= 12) into typed
// PgOutputMessage values. Pure byte decoding: no sockets, no I/O. A decoder instance owns the
// per-connection relation cache that later Insert/Update/Delete/Truncate messages reference by oid.
//
// What a tuple's TEXT means is `pg-values.ts`'s: this file frames messages, that one owns the type
// catalogue that turns postgres' text into the value a repository row holds.

import { ReplicationProtocolError } from './errors';
import { ByteReader, pgTimestampToEpochMs } from './pg-bytes';
import { decodeValue, type PhysicalRow } from './pg-values';

export interface PgColumn {
  /** part of the replica identity key — set by the `flags & 1` bit. */
  readonly key: boolean;
  /** the physical, snake_case column name as postgres reports it. */
  readonly name: string;
  readonly typeOid: number;
  readonly typeMod: number;
}

export interface PgRelation {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  /** 'd' default | 'n' nothing | 'f' full | 'i' index */
  readonly replicaIdentity: string;
  readonly columns: readonly PgColumn[];
}

export type PgOutputMessage =
  | {
      readonly kind: 'begin';
      readonly commitLsn: bigint;
      readonly commitAt: number;
      readonly xid: number;
    }
  | {
      readonly kind: 'commit';
      readonly commitLsn: bigint;
      readonly endLsn: bigint;
      readonly commitAt: number;
    }
  | { readonly kind: 'relation'; readonly relation: PgRelation }
  | { readonly kind: 'insert'; readonly relation: PgRelation; readonly after: PhysicalRow }
  | {
      readonly kind: 'update';
      readonly relation: PgRelation;
      readonly before: PhysicalRow | null;
      readonly after: PhysicalRow;
    }
  | { readonly kind: 'delete'; readonly relation: PgRelation; readonly before: PhysicalRow }
  | { readonly kind: 'truncate'; readonly relations: readonly PgRelation[] }
  /** origin / type / logical message — decoded far enough to be skipped safely. */
  | { readonly kind: 'other'; readonly tag: string };

/**
 * Int16 ncolumns + that many columns. Every tuple kind (insert's new row, update/delete's old
 * row, a `'K'` key-only row) shares this decoder: postgres always sends one byte per column,
 * `'u'` standing in for the columns a key-only tuple leaves out — so the column count always
 * matches the relation, and only the per-column byte tells us whether a value is actually there.
 */
function decodeTupleData(reader: ByteReader, relation: PgRelation): PhysicalRow {
  const count = reader.int16();
  if (count !== relation.columns.length) {
    throw new ReplicationProtocolError({
      stage: 'tuple',
      detail:
        `relation "${relation.schema}.${relation.name}" has ${relation.columns.length} columns ` +
        `but a tuple for it carried ${count}`,
    });
  }

  // Null-prototype: `column.name` is off the WIRE, so a column literally named `__proto__` set
  // the prototype of every row this decoder built. `Object.create(null)` has no prototype to set.
  const row: PhysicalRow = Object.create(null) as PhysicalRow;
  for (const column of relation.columns) {
    const kind = reader.tag();
    if (kind === 'n') {
      row[column.name] = null;
      continue;
    }
    if (kind === 'u') {
      // Omitted, not nulled: "unchanged" and "set to null" are different facts about the row,
      // and a missing key is the only encoding that keeps those two facts distinguishable.
      continue;
    }
    if (kind === 't') {
      const length = reader.int32();
      row[column.name] = decodeValue(column.typeOid, reader.utf8(length));
      continue;
    }
    if (kind === 'b') {
      throw new ReplicationProtocolError({
        stage: 'tuple',
        detail: `column "${column.name}" arrived as binary; this decoder only requests text-format values`,
      });
    }
    throw new ReplicationProtocolError({
      stage: 'tuple',
      detail: `column "${column.name}" has an unrecognised tuple kind "${kind}"`,
    });
  }
  return row;
}

/**
 * Holds the relation cache: postgres sends a `Relation` message once per table per connection and
 * every later tuple references it by oid, so a decoder instance is per-connection and is thrown
 * away with it.
 */
export class PgOutputDecoder {
  readonly #relations = new Map<number, PgRelation>();

  decode(payload: Uint8Array): PgOutputMessage {
    const reader = new ByteReader(payload, 'pgoutput');
    const tag = reader.tag();
    switch (tag) {
      case 'B':
        return this.#decodeBegin(reader);
      case 'C':
        return this.#decodeCommit(reader);
      case 'R':
        return this.#decodeRelation(reader);
      case 'I':
        return this.#decodeInsert(reader);
      case 'U':
        return this.#decodeUpdate(reader);
      case 'D':
        return this.#decodeDelete(reader);
      case 'T':
        return this.#decodeTruncate(reader);
      // 'O' (origin), 'Y' (type), 'M' (logical message), and any tag a newer server invents:
      // nothing downstream needs them decoded, and guessing at an unknown tag's shape is how a
      // truncated read turns into a silent misread instead of a clean skip.
      default:
        return { kind: 'other', tag };
    }
  }

  /** The relation behind an oid, for a caller that needs it after the fact. */
  relation(oid: number): PgRelation | undefined {
    return this.#relations.get(oid);
  }

  #relationOrThrow(oid: number): PgRelation {
    const relation = this.#relations.get(oid);
    if (relation === undefined) {
      throw new ReplicationProtocolError({
        stage: 'tuple',
        detail: `no Relation message has been seen yet for oid ${oid}`,
      });
    }
    return relation;
  }

  #decodeBegin(reader: ByteReader): PgOutputMessage {
    const commitLsn = reader.int64();
    const commitAt = pgTimestampToEpochMs(reader.int64());
    const xid = reader.int32();
    return { kind: 'begin', commitLsn, commitAt, xid };
  }

  #decodeCommit(reader: ByteReader): PgOutputMessage {
    reader.uint8(); // flags: reserved by the protocol, unused today.
    const commitLsn = reader.int64();
    const endLsn = reader.int64();
    const commitAt = pgTimestampToEpochMs(reader.int64());
    return { kind: 'commit', commitLsn, endLsn, commitAt };
  }

  #decodeRelation(reader: ByteReader): PgOutputMessage {
    const oid = reader.int32();
    const schema = reader.cstring();
    const name = reader.cstring();
    const replicaIdentity = reader.tag();
    const columnCount = reader.int16();
    const columns: PgColumn[] = [];
    for (let i = 0; i < columnCount; i += 1) {
      const flags = reader.uint8();
      const columnName = reader.cstring();
      const typeOid = reader.int32();
      const typeMod = reader.int32();
      columns.push({ key: (flags & 1) === 1, name: columnName, typeOid, typeMod });
    }
    // Always overwrites: postgres re-sends a Relation after a DDL change, and a stale column
    // list would silently mis-name every later value decoded against this oid.
    const relation: PgRelation = { oid, schema, name, replicaIdentity, columns };
    this.#relations.set(oid, relation);
    return { kind: 'relation', relation };
  }

  #decodeInsert(reader: ByteReader): PgOutputMessage {
    const relation = this.#relationOrThrow(reader.int32());
    reader.tag(); // always 'N' — a new row has no other kind.
    const after = decodeTupleData(reader, relation);
    return { kind: 'insert', relation, after };
  }

  #decodeUpdate(reader: ByteReader): PgOutputMessage {
    const relation = this.#relationOrThrow(reader.int32());
    let marker = reader.tag();
    let before: PhysicalRow | null = null;
    if (marker === 'K' || marker === 'O') {
      before = decodeTupleData(reader, relation);
      marker = reader.tag();
    }
    if (marker !== 'N') {
      throw new ReplicationProtocolError({
        stage: 'update',
        detail: `expected the new-tuple marker "N" but got "${marker}"`,
      });
    }
    const after = decodeTupleData(reader, relation);
    return { kind: 'update', relation, before, after };
  }

  #decodeDelete(reader: ByteReader): PgOutputMessage {
    const relation = this.#relationOrThrow(reader.int32());
    const marker = reader.tag();
    if (marker !== 'K' && marker !== 'O') {
      throw new ReplicationProtocolError({
        stage: 'delete',
        detail: `expected the old-tuple marker "K" or "O" but got "${marker}"`,
      });
    }
    const before = decodeTupleData(reader, relation);
    return { kind: 'delete', relation, before };
  }

  #decodeTruncate(reader: ByteReader): PgOutputMessage {
    const count = reader.int32();
    reader.uint8(); // flags: CASCADE / RESTART IDENTITY bits — advisory, not modelled downstream.
    const relations: PgRelation[] = [];
    for (let i = 0; i < count; i += 1) {
      const relation = this.#relations.get(reader.int32());
      // An oid with no cached Relation is skipped, not fatal: truncate is advisory for us.
      if (relation !== undefined) relations.push(relation);
    }
    return { kind: 'truncate', relations };
  }
}
