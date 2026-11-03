// Single responsibility: pins every builtin refusal's `rule` and `params` — the keys a translator
// writes `t(\`form.${issue.rule}\`, issue.params)` against. WHY a table: the vocabulary is contract
// like an `X_*` code, so a validator that stops naming its rule must fail here, not in a form.

import { describe, expect, test } from 'bun:test';
import { failWith } from './builder';
import type { SchemaIssueParams } from './schema-rules';
import { SCHEMA_RULES } from './schema-rules';
import type { StandardIssue } from './standard';
import { toValidationIssues, validate } from './standard';
import { builtinT as t } from './validators';

function firstIssue(schema: Parameters<typeof validate>[0], value: unknown): StandardIssue {
  const result = validate(schema, value);
  if (result.issues === undefined) return expect.unreachable('the value was accepted');
  const [issue] = result.issues;
  if (issue === undefined) return expect.unreachable('a refusal carried no issue');
  return issue;
}

const tagged = t.discriminatedUnion(
  'kind',
  t.object({ kind: t.literal('a') }),
  t.object({ kind: t.literal('b') }),
);

const CASES: readonly (readonly [
  string,
  Parameters<typeof validate>[0],
  unknown,
  SchemaIssueParams | undefined,
])[] = [
  ['required', t.object({ name: t.string }), {}, undefined],
  ['type', t.string, 42, { type: 'string' }],
  ['type', t.number, 'x', { type: 'number' }],
  ['type', t.boolean, 'x', { type: 'boolean' }],
  ['type', t.object({}), 'x', { type: 'object' }],
  ['type', t.array(t.string), 'x', { type: 'array' }],
  ['type', t.date, true, { type: 'date' }],
  ['type', t.money, 'x', { type: 'money' }],
  ['type', t.record(t.string), 'x', { type: 'record' }],
  ['string.min', t.string.min(3), '', { min: 3 }],
  ['string.min', t.string, '', { min: 1 }],
  ['string.max', t.string.max(2), 'abc', { max: 2 }],
  ['string.pattern', t.string.pattern(/^a+$/i), 'b', { pattern: '/^a+$/i' }],
  ['string.pattern', t.slug, 'A B', { pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }],
  ['string.format', t.uuid, 'nope', { format: 'uuid' }],
  ['string.format', t.email, 'nope', { format: 'email' }],
  ['string.format', t.url, 'nope', { format: 'uri' }],
  ['string.format', t.timezone, 'Mars/Base', { format: 'timezone' }],
  ['string.format', t.locale, '!!', { format: 'locale' }],
  ['string.format', t.date, 'March 14', { format: 'date-time' }],
  ['number.min', t.number.min(5), 1, { min: 5 }],
  ['number.max', t.number.max(5), 9, { max: 5 }],
  ['number.integer', t.number.int(), 1.5, undefined],
  ['enum', t.enumerated('a', 'b'), 'c', { values: 'a | b' }],
  ['literal', t.literal('on'), 'off', { value: '"on"' }],
  ['array.min', t.array(t.string, { min: 2 }), ['a'], { min: 2 }],
  ['array.max', t.array(t.string, { max: 1 }), ['a', 'b'], { max: 1 }],
  ['union', t.union(t.string, t.number), true, undefined],
  ['union', tagged, { kind: 'c' }, { values: 'a | b' }],
  ['record.key', t.record(t.string), { constructor: 'x' }, undefined],
  ['json', t.json(), { a: () => 1 }, undefined],
  ['money', t.money, { minor: 1.5, currency: 'EUR' }, undefined],
  [
    'refine',
    t
      .object({ a: t.number })
      .refine({ name: 'a-even', message: 'a is even', check: (v) => v.a % 2 === 0 }),
    { a: 1 },
    { name: 'a-even' },
  ],
];

describe('every builtin refusal names its rule', () => {
  for (const [rule, schema, value, params] of CASES) {
    test(`${rule} ${JSON.stringify(params ?? null)}`, () => {
      const issue = firstIssue(schema, value);
      expect(issue.rule).toBe(rule);
      expect(issue.params).toEqual(params);
    });
  }

  test('the table exercises every rule in the vocabulary', () => {
    expect(new Set(CASES.map(([rule]) => rule))).toEqual(new Set(SCHEMA_RULES));
  });

  test('the vocabulary is pinned: values are contract, add and never rename', () => {
    expect(SCHEMA_RULES).toMatchInlineSnapshot(`
      [
        "required",
        "type",
        "string.min",
        "string.max",
        "string.pattern",
        "string.format",
        "number.min",
        "number.max",
        "number.integer",
        "enum",
        "literal",
        "array.min",
        "array.max",
        "union",
        "record.key",
        "json",
        "money",
        "refine",
      ]
    `);
  });
});

describe('rule and params survive every hop to the issue a caller reads', () => {
  test('a nested field keeps its rule through objects, arrays and parse()', () => {
    const schema = t.object({ lines: t.array(t.object({ qty: t.number.min(1) })) });
    const issue = firstIssue(schema, { lines: [{ qty: 0 }] });
    expect(issue).toMatchObject({ rule: 'number.min', params: { min: 1 } });
    try {
      schema.parse({ lines: [{ qty: 0 }] });
      expect.unreachable('parse accepted a refused value');
    } catch (error) {
      expect(error).toMatchObject({
        meta: { issues: [{ path: 'lines[0].qty', rule: 'number.min', params: { min: 1 } }] },
      });
    }
  });

  test('toValidationIssues carries a string rule and drops a foreign non-string one', () => {
    const issues = toValidationIssues([
      { message: 'm', path: ['a'], rule: 'string.min', params: { min: 2 } },
      { message: 'm', path: ['b'], rule: 7 as unknown as string, params: { bad: {} } as never },
    ]);
    expect(issues[0]).toMatchObject({ rule: 'string.min', params: { min: 2 } });
    expect('rule' in (issues[1] ?? {})).toBe(false);
    expect('params' in (issues[1] ?? {})).toBe(false);
  });

  test('a provider issue with no rule stays without one', () => {
    const result = failWith([{ message: 'bad', path: [] }]);
    expect(result.issues[0]?.rule).toBeUndefined();
  });
});

describe('a builtin refusal cannot be written without a rule', () => {
  // `rejected` takes `rule` as a REQUIRED parameter; the hole left is a builtin file importing the
  // provider's optional-rule `fail` instead. This closes it for every file `t` is built from.
  const BUILTIN_FILES = [
    'validators.ts',
    'record-schema.ts',
    'array-schema.ts',
    'discriminated-union.ts',
    'money-value.ts',
    'json-value.ts',
  ] as const;
  for (const file of BUILTIN_FILES) {
    test(`${file} never calls fail(…)`, async () => {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
      expect(source.match(/\bfail\(/g) ?? []).toEqual([]);
    });
  }
});
