// Pins what `t.union` could not do: one branch's issues on failure instead of every branch's, and
// a `discriminant` in the IR that OpenAPI can project. The authoring refusals come first — an
// undispatchable member is wrong for every input, so it must fail at build, not at request time.

import { describe, expect, test } from 'bun:test';
import { discriminatedUnionSchema } from './discriminated-union';
import { isSchemaError, type SchemaError } from './errors';
import { toJsonSchema } from './json-schema';
import { validate } from './standard';
import { builtinT, objectSchema } from './validators';

const postBody = objectSchema({ kind: builtinT.literal('post'), slug: builtinT.slug });
const pageBody = objectSchema({ kind: builtinT.literal('page'), title: builtinT.string.min(3) });

function thrownBy(build: () => unknown): SchemaError {
  try {
    build();
  } catch (error) {
    if (isSchemaError(error)) return error;
    throw error;
  }
  return expect.unreachable('expected the union to refuse this member at build time');
}

describe('authoring refusals', () => {
  test('a member with no literal at the discriminant is refused when the union is built', () => {
    const error = thrownBy(() =>
      discriminatedUnionSchema('kind', postBody, objectSchema({ title: builtinT.string })),
    );
    expect(error.code).toBe('X_SCHEMA_DISCRIMINANT_INVALID');
    expect(error.cause).toContain('member #1');
    expect(error.fix).toContain("t.literal('…')");
  });

  test('a non-object member is refused for the same reason', () => {
    const error = thrownBy(() => discriminatedUnionSchema('kind', postBody, builtinT.string));
    expect(error.code).toBe('X_SCHEMA_DISCRIMINANT_INVALID');
    expect(error.meta).toMatchObject({ kind: 'string', index: 1 });
  });

  test('two members claiming one tag is refused — the second could never run', () => {
    const other = objectSchema({ kind: builtinT.literal('post'), other: builtinT.string });
    const error = thrownBy(() => discriminatedUnionSchema('kind', postBody, other));
    expect(error.code).toBe('X_SCHEMA_DISCRIMINANT_INVALID');
    expect(error.cause).toContain('already claims');
  });
});

describe('dispatch', () => {
  const body = discriminatedUnionSchema('kind', postBody, pageBody);

  test('routes to the branch the tag names', () => {
    expect(validate(body, { kind: 'post', slug: 'hello-world' }).issues).toBeUndefined();
    expect(validate(body, { kind: 'page', title: 'Hello' }).issues).toBeUndefined();
  });

  test('a failure reports ONLY the named branch — the fix t.union could not give', () => {
    const issues = validate(body, { kind: 'page', title: 'hi' }).issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['title']);
    // `t.union` answered "no union member matched (… | …)" here, naming `slug` — a field the
    // caller never sent and a rule that does not apply to the shape they asked for.
    expect(issues[0]?.message).not.toContain('slug');
    expect(issues[0]?.message).toContain('at least 3 chars');
  });

  test('an unknown tag names the tags that exist, at the discriminant path', () => {
    const issues = validate(body, { kind: 'comment' }).issues ?? [];
    expect(issues[0]?.path).toEqual(['kind']);
    expect(issues[0]?.message).toBe(
      'expected one of post | page, received a string of 7 characters',
    );
  });

  test('a missing tag is the same refusal, not a fallthrough to some branch', () => {
    const issues = validate(body, { slug: 'hello-world' }).issues ?? [];
    expect(issues[0]?.path).toEqual(['kind']);
    expect(issues[0]?.message).toContain('received undefined');
  });

  test('a non-object is refused without echoing it', () => {
    const issues = validate(body, 'kind=post').issues ?? [];
    expect(issues[0]?.message).toBe(
      'expected an object with a "kind" discriminant, received a string of 9 characters',
    );
  });

  test('an enum discriminant lets one branch own several tags', () => {
    const running = objectSchema({
      state: builtinT.enum(['queued', 'running']),
      workerId: builtinT.uuid,
    });
    const done = objectSchema({ state: builtinT.literal('done'), exitCode: builtinT.number.int() });
    const schema = discriminatedUnionSchema('state', running, done);
    const uuid = '018f4a1c-1b2c-7d3e-8f90-abcdef012345';
    expect(validate(schema, { state: 'queued', workerId: uuid }).issues).toBeUndefined();
    expect(validate(schema, { state: 'running', workerId: uuid }).issues).toBeUndefined();
    expect(validate(schema, { state: 'done', exitCode: 0 }).issues).toBeUndefined();
    expect(validate(schema, { state: 'running', workerId: 'nope' }).issues?.[0]?.path).toEqual([
      'workerId',
    ]);
  });

  test('a `false` literal is a legal tag — a truthiness gate used to call it undeclared', () => {
    const off = objectSchema({ enabled: builtinT.literal(false), reason: builtinT.string });
    const on = objectSchema({ enabled: builtinT.literal(true), rate: builtinT.number });
    const schema = discriminatedUnionSchema('enabled', off, on);
    expect(validate(schema, { enabled: false, reason: 'paused' }).issues).toBeUndefined();
    expect(validate(schema, { enabled: true, rate: 0.5 }).issues).toBeUndefined();
  });
});

describe('IR and projection', () => {
  const body = discriminatedUnionSchema('kind', postBody, pageBody);

  test('the node stays kind "union" so every existing consumer keeps working', () => {
    expect(body.node.kind).toBe('union');
    expect(body.node.discriminant).toBe('kind');
    expect(body.node.anyOf).toHaveLength(2);
  });

  test('JSON Schema carries anyOf plus the OpenAPI discriminator', () => {
    const json = toJsonSchema(body, { includeDialect: false });
    expect(json.anyOf).toHaveLength(2);
    expect(json.discriminator).toEqual({ propertyName: 'kind' });
  });

  test('an undiscriminated union emits no discriminator at all', () => {
    const json = toJsonSchema(builtinT.union(builtinT.uuid, builtinT.slug), {
      includeDialect: false,
    });
    expect(json.discriminator).toBeUndefined();
  });
});
