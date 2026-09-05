// `posts.$view(['id', 'title'])` — the hop between an entity and an action's `output`: a Standard
// Schema over a subset of the row, so `output: PostView` never re-declares a shape the columns
// already describe. Values are validated by the entity's own column parsers; an unknown key is a
// declaration-time failure, not a surprise on the first request.

import { renderThrowable } from '@ultimat3/core';
import { describeValue, type SchemaNode, type StandardSchemaV1 } from '@ultimat3/schema';
import { invariantViolated } from './errors';
import type { AnyColumn, ColumnMap } from './types';

/** What `bigint()` puts on a row: the digits, as a string — `columns-data.ts` parses by this. */
const BIGINT_PATTERN = '^-?\\d+$';
/** What `date()` puts on a row: `@ultimat3/time`'s `PlainDate`, a `YYYY-MM-DD` string. */
const PLAIN_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/**
 * A column as the schema IR reads it. This is what lets `output: PostView` reach OpenAPI, the
 * typed client and an MCP tool: before it, a view validated fine and was refused at projection
 * time with `X_SCHEMA_UNSUPPORTED` (measured 2026-09-05), so every app re-declared its outputs as
 * `t.object` and pinned them to the columns by hand.
 *
 * Each case publishes the ROW value's shape, which is not always the SQL type's: `bigint()` and
 * `decimal()` are `Column<string>` — the digits, because a JS number is inexact past ±2^53 and a
 * float is the money bug with a different name — and `date()` is a calendar-date string, not an
 * instant. A generated client typed off this document has to agree with what `$parse` returns,
 * so those three are strings here. `jsonb` and `bytea` are `unknown`: a `json()` column's schema
 * is not on its `$meta`, and bytes have no JSON form at all.
 */
export const columnNode = (column: AnyColumn): SchemaNode => {
  const meta = column.$meta;
  const base = ((): SchemaNode => {
    switch (meta.kind) {
      case 'uuid':
        return { kind: 'string', format: 'uuid' };
      case 'text':
      case 'char':
        return meta.values !== undefined
          ? { kind: 'enum', values: meta.values }
          : { kind: 'string', ...(meta.length === undefined ? {} : { maxLength: meta.length }) };
      case 'boolean':
        return { kind: 'boolean' };
      case 'integer':
        return { kind: 'number', integer: true };
      case 'bigint':
        return {
          kind: 'string',
          pattern: BIGINT_PATTERN,
          description: 'bigint as a decimal string',
        };
      case 'numeric':
        return { kind: 'string', description: 'exact decimal as a string' };
      case 'timestamptz':
        return { kind: 'date' };
      case 'date':
        return {
          kind: 'string',
          pattern: PLAIN_DATE_PATTERN,
          description: 'calendar date, YYYY-MM-DD',
        };
      case 'array':
        return {
          kind: 'array',
          items: meta.element === undefined ? { kind: 'unknown' } : columnNode(meta.element),
        };
      case 'money':
        return { kind: 'money' };
      default:
        return { kind: 'unknown' };
    }
  })();
  return meta.notNull ? base : { ...base, nullable: true };
};

/**
 * A row projection, usable anywhere a schema is. `$row` is the phantom that carries the type
 * (`type PostView = typeof PostView.$row`); `$name` is how a manifest or an OpenAPI document
 * identifies it.
 */
export interface EntityView<Row, K extends keyof Row & string>
  extends StandardSchemaV1<unknown, Pick<Row, K>> {
  /** The schema IR, so a view is introspectable wherever a `t.object` is. */
  readonly node: SchemaNode;
  readonly $name: string;
  readonly $keys: readonly K[];
  /** Phantom: `type PostView = typeof PostView.$row`. Reading it at runtime throws. */
  readonly $row: Pick<Row, K>;
}

/** Dots and underscores only, so the name is a legal `components.schemas` key unescaped. */
const viewName = (entityName: string, keys: readonly string[]): string =>
  `${entityName}.view.${keys.join('_')}`;

/**
 * Bound to an entity as `$view`; never exported as a free `view(entity, keys)`, because two ways
 * to write the same projection is exactly the ambiguity the `$`-prefixed surface exists to avoid.
 */
export const viewFor = <Row, K extends keyof Row & string>(
  entityName: string,
  columns: ColumnMap,
  keys: readonly K[],
): EntityView<Row, K> => {
  // Resolved once, at declaration: a key naming no column is the author's typo, and the columns
  // are listed because the agent reading the error is the one that has to pick the right key.
  const picked: readonly (readonly [K, AnyColumn])[] = keys.map((key) => {
    const column = columns[key];
    if (column === undefined) {
      throw invariantViolated(
        entityName,
        'view',
        `$view(['${key}']) names no column — pick from: ${Object.keys(columns).join(', ')}`,
      );
    }
    return [key, column] as const;
  });
  const name = viewName(entityName, keys);
  // No `description`: the view's name is `$name`, and OpenAPI keys the component by the ACTION's
  // output name, so a description repeating `posts.view.id_title` would be noise on every field.
  const node: SchemaNode = {
    kind: 'object',
    properties: Object.fromEntries(picked.map(([key, column]) => [key, columnNode(column)])),
  };

  const parse = (value: unknown): Pick<Row, K> => {
    if (typeof value !== 'object' || value === null) {
      // Shape, never content — the same renderer `columns.ts` uses, for the same reason: a
      // view issue is folded into `X_BODY_INVALID` and reaches the caller and the log line.
      throw invariantViolated(
        entityName,
        'view',
        `expected an object, got ${describeValue(value)}`,
      );
    }
    const input = value as Readonly<Record<string, unknown>>;
    const projected = {} as Record<K, unknown>;
    for (const [key, column] of picked) {
      const given = input[key];
      if (given === undefined || given === null) {
        // No default is filled in: a view projects a row that already exists, so an absent
        // required column is missing data, never a value the projection may invent.
        if (column.$meta.notNull) throw invariantViolated(entityName, `view.${key}`, 'is required');
        projected[key] = null;
        continue;
      }
      projected[key] = column.$parse(given);
    }
    // Every picked key went through its own column's parser, so this is the derived projection.
    return projected as Pick<Row, K>;
  };

  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate',
      validate: (value) => {
        try {
          return { value: parse(value) };
        } catch (error) {
          // The entity's rule, for the same reason: `instanceof` and `String()` are both reads of
          // a caught value, and a throwable that fights being read turned a rejected projection
          // into an uncatchable `TypeError`. `renderThrowable` is total.
          return { issues: [{ message: renderThrowable(error) }] };
        }
      },
    },
    // `node` is the duck-typed key `nodeOf()` reads — the same one every `t.*` schema carries.
    node,
    $name: name,
    $keys: keys,
    get $row(): Pick<Row, K> {
      // Type-only, exactly as on the entity. Reading it means a type was meant.
      throw invariantViolated(
        entityName,
        'view.$row',
        '$row is a type, not a value — use typeof x.$row',
      );
    },
  };
};
