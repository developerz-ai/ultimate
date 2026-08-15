// Single responsibility: the blessed `t` namespace. One import, one way to declare a schema.
// Every member delegates to the active provider, so `configureSchemaProvider()` takes effect
// even for modules that captured `t` at import time.

import type { AnySchema, Schema, Shape } from './builder';
import type { MoneyValue } from './money-value';
import { schemaProvider } from './provider';
import type { InferInput, InferOutput, StandardSchemaV1 } from './standard';
import type { NumberSchema, ObjectSchema, StringSchema, TNamespace } from './validators';

function provider(): TNamespace {
  return schemaProvider().t;
}

export const t: TNamespace = {
  get string(): StringSchema {
    return provider().string;
  },
  get number(): NumberSchema {
    return provider().number;
  },
  get boolean(): Schema<boolean, boolean> {
    return provider().boolean;
  },
  get uuid(): StringSchema {
    return provider().uuid;
  },
  get email(): StringSchema {
    return provider().email;
  },
  get url(): StringSchema {
    return provider().url;
  },
  get date(): Schema<Date | string | number, Date> {
    return provider().date;
  },
  get money(): Schema<MoneyValue, MoneyValue> {
    return provider().money;
  },
  get timezone(): StringSchema {
    return provider().timezone;
  },
  get locale(): StringSchema {
    return provider().locale;
  },
  get slug(): StringSchema {
    return provider().slug;
  },
  get cursor(): StringSchema {
    return provider().cursor;
  },
  object<S extends Shape>(shape: S): ObjectSchema<S> {
    return provider().object(shape);
  },
  array<S extends AnySchema>(items: S): Schema<readonly InferInput<S>[], InferOutput<S>[]> {
    return provider().array(items);
  },
  enum<const V extends readonly [string, ...string[]]>(values: V): Schema<V[number], V[number]> {
    return provider().enum(values);
  },
  /**
   * Variadic form of `enum`, and the blessed spelling: it spreads a `const` tuple of codes
   * straight from the domain package (`t.enumerated(...PLAN_CODES)`) and avoids the reserved
   * word at the call site.
   */
  enumerated<const V extends readonly [string, ...string[]]>(
    ...values: V
  ): Schema<V[number], V[number]> {
    return provider().enum(values);
  },
  literal<const V extends string | number | boolean>(value: V): Schema<V, V> {
    return provider().literal(value);
  },
  union<S extends readonly [AnySchema, ...AnySchema[]]>(
    ...members: S
  ): Schema<InferInput<S[number]>, InferOutput<S[number]>> {
    return provider().union(...members);
  },
  record<S extends AnySchema>(
    values: S,
  ): Schema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>> {
    return provider().record(values);
  },
  /** `t.nullable(t.url)` — the column may hold null, which is not the same as being absent. */
  nullable<S extends AnySchema>(schema: S): Schema<InferInput<S> | null, InferOutput<S> | null> {
    return schema.nullable() as Schema<InferInput<S> | null, InferOutput<S> | null>;
  },
  optional<S extends AnySchema>(
    schema: S,
  ): Schema<InferInput<S> | undefined, InferOutput<S> | undefined> {
    return provider().optional(schema);
  },
};

/** `type PublishInput = Infer<typeof publishInput>` */
export type Infer<S extends StandardSchemaV1> = InferOutput<S>;
