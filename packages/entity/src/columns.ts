// The blessed column helpers. There is exactly one way to store an id, a timestamp,
// money, a locale and a time zone — the alternatives (float money, naive timestamps,
// a single implied currency) are the bugs this file exists to make unreachable.
import { uuid } from '@ultimat3/core';
import { invariantViolated } from './errors';
import type { ColumnDef, ColumnMap, IndexDef, TableDef } from './types';

const snake = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const reject = (column: string, rule: string, detail: string): never => {
  throw invariantViolated(column, rule, detail);
};

interface ColumnOptions {
  readonly name?: string;
  readonly comment?: string;
}

const base = <T>(
  kind: ColumnDef<T>['kind'],
  parse: (value: unknown) => T,
  overrides: Partial<ColumnDef<T>> = {},
): ColumnDef<T> => ({
  // '' means "derive from the property key in table()", so a column is declared once.
  name: '',
  kind,
  notNull: true,
  primaryKey: false,
  unique: false,
  index: false,
  parse,
  ...overrides,
});

const asString =
  (label: string) =>
  (value: unknown): string => {
    if (typeof value === 'string') return value;
    return reject(label, 'type', `expected a string, got ${typeof value}`);
  };

const asDate =
  (label: string) =>
  (value: unknown): Date => {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return reject(label, 'type', `expected a Date or ISO-8601 string, got ${String(value)}`);
  };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid =
  (label: string) =>
  (value: unknown): string => {
    if (typeof value === 'string' && UUID.test(value)) return value;
    return reject(label, 'format', `expected a uuid, got ${String(value)}`);
  };

/** uuid v7: time-ordered, so a primary key index stays append-friendly. */
export const newId = (): string => uuid();

export const id = (options: ColumnOptions = {}): ColumnDef<string> =>
  base<string>('uuid', asUuid('id'), {
    ...options,
    name: options.name ?? 'id',
    primaryKey: true,
    default: { kind: 'generated', by: 'uuid-v7' },
  });

/**
 * A uuid column that is not the primary key — foreign keys (`authorId`, `postId`).
 * Distinct from `id()`: no `primaryKey`, and no generated default, because a reference
 * is supplied by the caller. Using `id()` for a foreign key would silently claim the
 * table has two primary keys.
 */
export const uuidColumn = (options: ColumnOptions = {}): ColumnDef<string> =>
  base<string>('uuid', asUuid(options.name ?? 'uuid'), options);

/**
 * A single `timestamptz`. `timestamps()` covers created/updated; a domain instant like
 * `publishedAt` needs its own column. Always `timestamptz` — there is no naive variant
 * and there will not be one.
 */
export const timestamp = (options: ColumnOptions = {}): ColumnDef<Date> =>
  base<Date>(
    'timestamptz',
    (value: unknown): Date => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      if (typeof value === 'string') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
      return reject(
        options.name ?? 'timestamp',
        'format',
        `expected a UTC instant, got ${String(value)}`,
      );
    },
    options,
  );

/**
 * A closed set of string values, emitted as a CHECK rather than a Postgres `ENUM` type:
 * adding a variant is then a one-line migration instead of `ALTER TYPE`, which cannot run
 * inside a transaction on older servers.
 */
export const enumerated = <const T extends readonly string[]>(
  values: T,
  options: ColumnOptions = {},
): ColumnDef<T[number]> => {
  const label = options.name ?? 'enum';
  const allowed = new Set<string>(values);
  return base<T[number]>(
    'text',
    (value: unknown): T[number] => {
      if (typeof value === 'string' && allowed.has(value)) return value as T[number];
      return reject(label, 'enum', `expected one of ${values.join(' | ')}, got ${String(value)}`);
    },
    { ...options, check: `${label} in (${values.map((v) => `'${v}'`).join(', ')})` },
  );
};

/**
 * An absolute http(s) URL. Validated on write rather than on render: a bad URL stored once
 * is served to every reader, and `<img src>` fails silently in the browser.
 */
export const url = (options: ColumnOptions = {}): ColumnDef<string> => {
  const label = options.name ?? 'url';
  return base<string>(
    'text',
    (value: unknown): string => {
      if (typeof value === 'string') {
        try {
          const parsed = new URL(value);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
        } catch {
          // fall through to the shared rejection so the error carries the column name
        }
      }
      return reject(label, 'format', `expected an absolute http(s) URL, got ${String(value)}`);
    },
    options,
  );
};

export const text = (options: ColumnOptions & { readonly check?: string } = {}) =>
  base<string>('text', asString(options.name ?? 'text'), options);

const asBoolean =
  (label: string) =>
  (value: unknown): boolean =>
    typeof value === 'boolean'
      ? value
      : reject(label, 'type', `expected a boolean, got ${typeof value}`);

const asInteger =
  (label: string) =>
  (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : reject(label, 'type', `expected a safe integer, got ${String(value)}`);

const asCurrency =
  (label: string) =>
  (value: unknown): string =>
    typeof value === 'string' && /^[A-Z]{3}$/.test(value)
      ? value
      : reject(label, 'iso-4217', `expected a 3-letter ISO-4217 code, got ${String(value)}`);

export const boolean = (options: ColumnOptions = {}): ColumnDef<boolean> =>
  base<boolean>('boolean', asBoolean(options.name ?? 'boolean'), options);

export const integer = (
  options: ColumnOptions & { readonly check?: string } = {},
): ColumnDef<number> => base<number>('integer', asInteger(options.name ?? 'integer'), options);

/** UTC always. A `timestamp without time zone` column is not expressible here. */
export const timestamps = (): {
  readonly createdAt: ColumnDef<Date>;
  readonly updatedAt: ColumnDef<Date>;
} => ({
  createdAt: base<Date>('timestamptz', asDate('createdAt'), {
    name: 'created_at',
    default: { kind: 'generated', by: 'now' },
    index: true,
  }),
  updatedAt: base<Date>('timestamptz', asDate('updatedAt'), {
    name: 'updated_at',
    default: { kind: 'generated', by: 'now' },
  }),
});

export type MoneyColumns<N extends string> = {
  readonly [K in `${N}Minor`]: ColumnDef<bigint>;
} & {
  readonly [K in `${N}Currency`]: ColumnDef<string>;
};

const asMinorUnits =
  (label: string) =>
  (value: unknown): bigint => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        return reject(
          label,
          'money-minor-units',
          `got the float ${value}; money is integer minor units — 12.34 EUR is 1234n, not 12.34`,
        );
      }
      return BigInt(value);
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
    return reject(label, 'money-minor-units', `expected integer minor units, got ${String(value)}`);
  };

/**
 * Two columns, always: minor units as bigint and an ISO-4217 code. A single-currency
 * assumption is a migration nobody wants to write later, and a float is a rounding
 * bug nobody wants to debug.
 */
export const money = <N extends string>(name: N): MoneyColumns<N> =>
  ({
    [`${name}Minor`]: base<bigint>('bigint', asMinorUnits(`${name}Minor`), {
      name: `${snake(name)}_minor`,
    }),
    [`${name}Currency`]: base<string>('char', asCurrency(`${name}Currency`), {
      name: `${snake(name)}_currency`,
      length: 3,
      check: `${snake(name)}_currency ~ '^[A-Z]{3}$'`,
    }),
  }) as unknown as MoneyColumns<N>;

/** IANA identifier, validated by `Intl` at write time and by a CHECK in the database. */
export const tz = (options: ColumnOptions = {}): ColumnDef<string> => {
  const label = options.name ?? 'tz';
  return base<string>(
    'text',
    (value) => {
      if (typeof value === 'string') {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
          return value;
        } catch {
          return reject(label, 'iana-tz', `${value} is not an IANA time zone`);
        }
      }
      return reject(label, 'iana-tz', `expected an IANA time zone, got ${typeof value}`);
    },
    { ...options, check: `${snake(label)} ~ '^[A-Za-z0-9_+/-]{3,64}$'` },
  );
};

export const locale = (options: ColumnOptions = {}): ColumnDef<string> => {
  const label = options.name ?? 'locale';
  return base<string>('text', asString(label), {
    ...options,
    check: `${snake(label)} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
  });
};

export const slug = (options: ColumnOptions = {}): ColumnDef<string> => {
  const label = options.name ?? 'slug';
  return base<string>('text', asString(label), {
    ...options,
    unique: true,
    check: `${snake(label)} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
  });
};

/** Takes its own parser: a jsonb column without a schema is an untyped hole. */
export const jsonb = <T>(parse: (value: unknown) => T, options: ColumnOptions = {}): ColumnDef<T> =>
  base<T>('jsonb', parse, options);

/** Presence of this column is what makes an entity soft-deletable — not a flag. */
export const softDelete = (): { readonly deletedAt: ColumnDef<Date | null> } => ({
  deletedAt: base<Date | null>(
    'timestamptz',
    (value) => (value === null || value === undefined ? null : asDate('deletedAt')(value)),
    { name: 'deleted_at', notNull: false, index: true },
  ),
});

/** Presence of this column is what makes an entity tenant-scoped. See tenancy.ts. */
export const orgId = (options: ColumnOptions & { readonly table?: string } = {}) =>
  base<string>('uuid', asUuid('orgId'), {
    name: options.name ?? 'org_id',
    index: true,
    references: { table: options.table ?? 'orgs', column: 'id', onDelete: 'cascade' },
  });

export const nullable = <T>(column: ColumnDef<T>): ColumnDef<T | null> => ({
  ...column,
  notNull: false,
  parse: (value) => (value === null || value === undefined ? null : column.parse(value)),
});

export const references = <T>(column: ColumnDef<T>, target: string, targetColumn = 'id') => ({
  ...column,
  index: true,
  references: { table: target, column: targetColumn },
});

/**
 * Composes columns into a table, filling every column name that was left to the
 * property key (`orgId` -> `org_id`) so a physical name is written at most once.
 */
export const table = <C extends ColumnMap>(name: string, columns: C): TableDef<C> => {
  const resolved: Record<string, ColumnDef<unknown>> = {};
  const primaryKey: string[] = [];
  const indexes: IndexDef[] = [];
  for (const [property, column] of Object.entries(columns)) {
    const physical = column.name === '' ? snake(property) : column.name;
    resolved[property] = { ...column, name: physical };
    if (column.primaryKey) primaryKey.push(physical);
    if (column.unique) {
      indexes.push({ name: `${name}_${physical}_key`, columns: [physical], unique: true });
    } else if (column.index) {
      indexes.push({ name: `${name}_${physical}_idx`, columns: [physical], unique: false });
    }
  }
  return {
    name,
    columns: resolved as unknown as C,
    primaryKey: primaryKey.length > 0 ? primaryKey : ['id'],
    indexes,
  };
};
