// `posts.$view(['id', 'title'])` — the hop between an entity and an action's `output`: a Standard
// Schema over a subset of the row, so `output: PostView` never re-declares a shape the columns
// already describe. Values are validated by the entity's own column parsers; an unknown key is a
// declaration-time failure, not a surprise on the first request.

import { describeValue, type StandardSchemaV1 } from '@ultimat3/schema';
import { invariantViolated } from './errors';
import type { AnyColumn, ColumnMap } from './types';

/**
 * A row projection, usable anywhere a schema is. `$row` is the phantom that carries the type
 * (`type PostView = typeof PostView.$row`); `$name` is how a manifest or an OpenAPI document
 * identifies it.
 */
export interface EntityView<Row, K extends keyof Row & string>
  extends StandardSchemaV1<unknown, Pick<Row, K>> {
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
          return {
            issues: [{ message: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    },
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
