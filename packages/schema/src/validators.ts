// Single responsibility: the builtin, dependency-free validators behind `t`. Small on purpose —
// ArkType or Zod replace them wholesale via `configureSchemaProvider()`; the IR and the
// Standard Schema surface are what the rest of the framework actually depends on.

import {
  type AnySchema,
  type Check,
  checkOf,
  expected,
  fail,
  failWith,
  makeSchema,
  pass,
  type Schema,
  type Shape,
  type ShapeInput,
  type ShapeOutput,
} from './builder';
import type { SchemaNode } from './node';
import type { InferInput, InferOutput, StandardIssue } from './standard';

/** Structurally identical to `Money` in `@ultimat3/money`. Never a float. */
export interface MoneyValue {
  readonly minor: number;
  readonly currency: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

export interface StringSchema extends Schema<string, string> {
  min(length: number): StringSchema;
  max(length: number): StringSchema;
  pattern(regex: RegExp): StringSchema;
}

export interface NumberSchema extends Schema<number, number> {
  min(value: number): NumberSchema;
  max(value: number): NumberSchema;
  int(): NumberSchema;
}

export interface ObjectSchema<S extends Shape> extends Schema<ShapeInput<S>, ShapeOutput<S>> {
  readonly shape: S;
  extend<E extends Shape>(extra: E): ObjectSchema<Simplified<S & E>>;
  pick<K extends keyof S & string>(...keys: readonly K[]): ObjectSchema<Pick<S, K>>;
  omit<K extends keyof S & string>(...keys: readonly K[]): ObjectSchema<Omit<S, K>>;
}

type Simplified<S> = { [K in keyof S]: S[K] } & {};

function stringLike(node: SchemaNode, what: string, test?: (value: string) => boolean) {
  const check: Check<string> = (value, path) => {
    if (typeof value !== 'string') return fail(path, expected(what, value));
    if (node.minLength !== undefined && value.length < node.minLength) {
      return fail(path, expected(`${what} of at least ${node.minLength} chars`, value));
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      return fail(path, expected(`${what} of at most ${node.maxLength} chars`, value));
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
      return fail(path, expected(`${what} matching ${node.pattern}`, value));
    }
    if (test !== undefined && !test(value)) return fail(path, expected(what, value));
    return pass(value);
  };
  return check;
}

function makeStringSchema(
  node: SchemaNode,
  what: string,
  test?: (value: string) => boolean,
): StringSchema {
  const base = makeSchema<string, string>(node, stringLike(node, what, test));
  return {
    ...base,
    min: (length) => makeStringSchema({ ...node, minLength: length }, what, test),
    max: (length) => makeStringSchema({ ...node, maxLength: length }, what, test),
    pattern: (regex) => makeStringSchema({ ...node, pattern: regex.source }, what, test),
  };
}

function makeNumberSchema(node: SchemaNode): NumberSchema {
  const check: Check<number> = (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(path, expected('a finite number', value));
    }
    if (node.integer === true && !Number.isInteger(value)) {
      return fail(path, expected('an integer', value));
    }
    if (node.minimum !== undefined && value < node.minimum) {
      return fail(path, expected(`a number >= ${node.minimum}`, value));
    }
    if (node.maximum !== undefined && value > node.maximum) {
      return fail(path, expected(`a number <= ${node.maximum}`, value));
    }
    return pass(value);
  };
  const base = makeSchema<number, number>(node, check);
  return {
    ...base,
    min: (value) => makeNumberSchema({ ...node, minimum: value }),
    max: (value) => makeNumberSchema({ ...node, maximum: value }),
    int: () => makeNumberSchema({ ...node, integer: true }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function objectSchema<S extends Shape>(shape: S): ObjectSchema<S> {
  const properties: Record<string, SchemaNode> = {};
  const checks: [string, Check<unknown>][] = [];
  for (const [key, member] of Object.entries(shape)) {
    properties[key] = member.node;
    checks.push([key, checkOf(member)]);
  }
  const node: SchemaNode = { kind: 'object', properties };

  const check: Check<ShapeOutput<S>> = (value, path) => {
    if (!isPlainObject(value)) return fail(path, expected('an object', value));
    const issues: StandardIssue[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, memberCheck] of checks) {
      const result = memberCheck(value[key], [...path, key]);
      if (result.ok) {
        // Unknown keys are dropped, never forwarded — no mass assignment through an action.
        if (result.value !== undefined) out[key] = result.value;
      } else {
        issues.push(...result.issues);
      }
    }
    if (issues.length > 0) return failWith(issues);
    return pass(out as ShapeOutput<S>);
  };

  const base = makeSchema<ShapeInput<S>, ShapeOutput<S>>(node, check);
  return {
    ...base,
    shape,
    extend: (extra) => objectSchema({ ...shape, ...extra } as Simplified<S & typeof extra>),
    pick: (...keys) => {
      const next: Record<string, AnySchema> = {};
      for (const key of keys) next[key] = shape[key] as AnySchema;
      return objectSchema(next) as ObjectSchema<Pick<S, (typeof keys)[number]>>;
    },
    omit: (...keys) => {
      const drop = new Set<string>(keys);
      const next: Record<string, AnySchema> = {};
      for (const [key, member] of Object.entries(shape)) {
        if (!drop.has(key)) next[key] = member;
      }
      return objectSchema(next) as ObjectSchema<Omit<S, (typeof keys)[number]>>;
    },
  };
}

export function arraySchema<S extends AnySchema>(
  items: S,
): Schema<readonly InferInput<S>[], InferOutput<S>[]> {
  const itemCheck = checkOf(items);
  const node: SchemaNode = { kind: 'array', items: items.node };
  return makeSchema<readonly InferInput<S>[], InferOutput<S>[]>(node, (value, path) => {
    if (!Array.isArray(value)) return fail(path, expected('an array', value));
    const issues: StandardIssue[] = [];
    const out: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const result = itemCheck(item, [...path, index]);
      if (result.ok) out.push(result.value);
      else issues.push(...result.issues);
    }
    if (issues.length > 0) return failWith(issues);
    return pass(out as InferOutput<S>[]);
  });
}

export function enumSchema<const V extends readonly [string, ...string[]]>(
  values: V,
): Schema<V[number], V[number]> {
  const node: SchemaNode = { kind: 'enum', values: [...values] };
  return makeSchema<V[number], V[number]>(node, (value, path) => {
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
      return pass(value as V[number]);
    }
    return fail(path, expected(`one of ${values.join(' | ')}`, value));
  });
}

export function literalSchema<const V extends string | number | boolean>(value: V): Schema<V, V> {
  const node: SchemaNode = { kind: 'literal', literal: value };
  return makeSchema<V, V>(node, (candidate, path) =>
    candidate === value ? pass(value) : fail(path, expected(JSON.stringify(value), candidate)),
  );
}

export function unionSchema<S extends readonly [AnySchema, ...AnySchema[]]>(
  ...members: S
): Schema<InferInput<S[number]>, InferOutput<S[number]>> {
  const checks = members.map((member) => checkOf(member));
  const node: SchemaNode = { kind: 'union', anyOf: members.map((member) => member.node) };
  return makeSchema<InferInput<S[number]>, InferOutput<S[number]>>(node, (value, path) => {
    const reasons: string[] = [];
    for (const memberCheck of checks) {
      const result = memberCheck(value, path);
      if (result.ok) return pass(result.value as InferOutput<S[number]>);
      reasons.push(result.issues.map((issue) => issue.message).join(', '));
    }
    return fail(path, `no union member matched (${reasons.join(' | ')})`);
  });
}

export function recordSchema<S extends AnySchema>(
  values: S,
): Schema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>> {
  const valueCheck = checkOf(values);
  const node: SchemaNode = { kind: 'record', valueNode: values.node };
  return makeSchema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>>(
    node,
    (value, path) => {
      if (!isPlainObject(value)) return fail(path, expected('an object', value));
      const issues: StandardIssue[] = [];
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const result = valueCheck(entry, [...path, key]);
        if (result.ok) out[key] = result.value;
        else issues.push(...result.issues);
      }
      if (issues.length > 0) return failWith(issues);
      return pass(out as Record<string, InferOutput<S>>);
    },
  );
}

export function optionalSchema<S extends AnySchema>(
  schema: S,
): Schema<InferInput<S> | undefined, InferOutput<S> | undefined> {
  return schema.optional() as Schema<InferInput<S> | undefined, InferOutput<S> | undefined>;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

const dateSchema: Schema<Date | string | number, Date> = makeSchema<Date | string | number, Date>(
  { kind: 'date', format: 'date-time' },
  (value, path) => {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? fail(path, expected('a valid Date', value))
        : pass(value);
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? fail(path, expected('an ISO-8601 date-time', value))
        : pass(parsed);
    }
    return fail(path, expected('an ISO-8601 date-time', value));
  },
);

const moneySchema: Schema<MoneyValue, MoneyValue> = makeSchema<MoneyValue, MoneyValue>(
  {
    kind: 'money',
    description: 'integer minor units plus an ISO 4217 currency code',
    properties: {
      minor: { kind: 'number', integer: true },
      currency: { kind: 'string', pattern: CURRENCY_RE.source },
    },
  },
  (value, path) => {
    if (!isPlainObject(value)) return fail(path, expected('a Money object', value));
    const minor = value['minor'];
    const currency = value['currency'];
    const issues: StandardIssue[] = [];
    if (typeof minor !== 'number' || !Number.isInteger(minor)) {
      issues.push({
        message: expected('an integer number of minor units', minor),
        path: [...path, 'minor'],
      });
    }
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      issues.push({
        message: expected('a 3-letter ISO 4217 code', currency),
        path: [...path, 'currency'],
      });
    }
    if (issues.length > 0) return failWith(issues);
    return pass({ minor: minor as number, currency: currency as string });
  },
);

/** The shape a schema provider must implement to back `t`. */
export interface TNamespace {
  readonly string: StringSchema;
  readonly number: NumberSchema;
  readonly boolean: Schema<boolean, boolean>;
  readonly uuid: StringSchema;
  readonly email: StringSchema;
  readonly url: StringSchema;
  readonly date: Schema<Date | string | number, Date>;
  readonly money: Schema<MoneyValue, MoneyValue>;
  readonly timezone: StringSchema;
  readonly locale: StringSchema;
  readonly slug: StringSchema;
  readonly cursor: StringSchema;
  object<S extends Shape>(shape: S): ObjectSchema<S>;
  array<S extends AnySchema>(items: S): Schema<readonly InferInput<S>[], InferOutput<S>[]>;
  enum<const V extends readonly [string, ...string[]]>(values: V): Schema<V[number], V[number]>;
  literal<const V extends string | number | boolean>(value: V): Schema<V, V>;
  union<S extends readonly [AnySchema, ...AnySchema[]]>(
    ...members: S
  ): Schema<InferInput<S[number]>, InferOutput<S[number]>>;
  record<S extends AnySchema>(
    values: S,
  ): Schema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>>;
  optional<S extends AnySchema>(
    schema: S,
  ): Schema<InferInput<S> | undefined, InferOutput<S> | undefined>;
}

export const builtinT: TNamespace = Object.freeze({
  string: makeStringSchema({ kind: 'string', minLength: 1 }, 'a non-empty string'),
  number: makeNumberSchema({ kind: 'number' }),
  boolean: makeSchema<boolean, boolean>({ kind: 'boolean' }, (value, path) =>
    typeof value === 'boolean' ? pass(value) : fail(path, expected('a boolean', value)),
  ),
  uuid: makeStringSchema({ kind: 'string', format: 'uuid' }, 'a uuid', (value) =>
    UUID_RE.test(value),
  ),
  email: makeStringSchema({ kind: 'string', format: 'email' }, 'an email address', (value) =>
    EMAIL_RE.test(value),
  ),
  url: makeStringSchema({ kind: 'string', format: 'uri' }, 'an absolute URL', (value) =>
    URL.canParse(value),
  ),
  date: dateSchema,
  money: moneySchema,
  timezone: makeStringSchema(
    { kind: 'string', format: 'timezone' },
    'an IANA time zone',
    isTimeZone,
  ),
  locale: makeStringSchema({ kind: 'string', format: 'locale' }, 'a BCP-47 locale', isLocale),
  slug: makeStringSchema({ kind: 'string', format: 'slug', pattern: SLUG_RE.source }, 'a slug'),
  cursor: makeStringSchema(
    { kind: 'string', format: 'cursor', pattern: CURSOR_RE.source },
    'an opaque base64url cursor',
  ),
  object: objectSchema,
  array: arraySchema,
  enum: enumSchema,
  literal: literalSchema,
  union: unionSchema,
  record: recordSchema,
  optional: optionalSchema,
});
