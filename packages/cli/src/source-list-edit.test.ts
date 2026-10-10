// The list editor every generator that grows an array goes through. What it must never do is read
// a comment or a literal as code: `x g entity` took each apostrophe in a role map's comments for a
// string delimiter and rewrote the comments into permissions. Property-style: every shape below is
// crossed with every hazard, and each result is judged by the same four invariants.

import { describe, expect, test } from 'bun:test';
import {
  absentFrom,
  appendToList,
  closingBracket,
  maskOf,
  readList,
  readProperties,
} from './source-list-edit';

/** The index of the `[` that follows `anchor` in `source`. */
const openAfter = (source: string, anchor: string): number =>
  source.indexOf('[', source.indexOf(anchor));

const entriesOf = (source: string, anchor: string): readonly string[] =>
  readList(source, maskOf(source), openAfter(source, anchor))?.entries.map((one) => one.text) ??
  expect.unreachable('the list does not read back');

/** Every comment and template literal in `source`, in order — what an edit may never change. */
const proseOf = (source: string): readonly string[] =>
  source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`/g) ?? [];

/** Things that are not code and look like it: each lands between two entries of a list. */
const HAZARDS: readonly (readonly [string, string])[] = [
  ['an apostrophe in a line comment', "// the firm's terms; it can't be granted twice"],
  ['two apostrophes that would pair up', "// lawyers' seats and owners' seats"],
  ['a closing bracket in a comment', '// see roles[0] and the list above ]'],
  ['a comma and quotes in a comment', '// \'not:an-entry\', "nor:this", nor this'],
  ['a backtick in a comment', "// `actorFact(actor, 'kycApproved')` decides, not a grant"],
  ['a block comment with every delimiter', "/* it's [not] {code}, `at all` */"],
  ['a doc block over two rows', "/**\n   * The owner's row — see ']' below.\n   */"],
];

/** Entries whose own text holds what a naive scan splits on. */
const AWKWARD_ENTRIES: readonly string[] = [
  "'plain:read'",
  "'with,comma:read'",
  "'with]bracket:read'",
  '"double:read"',
  "'it\\'s:read'",
  '`template:read`',
  '...other.all',
  "pick(['nested', 'call'])",
];

describe('unit · appending to a list never reads a comment or a literal as code', () => {
  for (const [name, hazard] of HAZARDS) {
    for (const trailing of [true, false]) {
      test(`${name} — ${trailing ? 'trailing comma' : 'no trailing comma'}`, () => {
        const body = AWKWARD_ENTRIES.flatMap((entry, index) => [
          `  ${hazard}`,
          `  ${entry}${index < AWKWARD_ENTRIES.length - 1 || trailing ? ',' : ''}`,
        ]).join('\n');
        const source = `// it's the header\nexport const all = define([\n${body}\n]);\n\nconst after = \`it's [kept]\`;\n`;
        const next = appendToList(source, openAfter(source, 'define('), [
          "'new:read'",
          "'new:write'",
        ]);
        if (next === undefined) return expect.unreachable('a safe edit was refused');
        // 1. The list is what it was, then the new entries.
        expect(entriesOf(next, 'define(')).toEqual([
          ...AWKWARD_ENTRIES,
          "'new:read'",
          "'new:write'",
        ]);
        // 2. Every comment and template literal is byte-identical, in order.
        expect(proseOf(next)).toEqual(proseOf(source));
        // 3. Nothing was removed: taking the inserted rows back out is the original but for the
        //    one comma a last entry without one owed.
        const removed = next.replace("  'new:read',\n  'new:write',\n", '');
        expect(removed.length - source.length).toBe(trailing ? 0 : 1);
        // 4. A second run changes nothing.
        expect(appendToList(next, openAfter(next, 'define('), ["'new:read'", "'new:write'"])).toBe(
          next,
        );
      });
    }
  }

  test('an entry already there is not added again — whatever quote it is written in', () => {
    const source = "const a = [\n  // it's here\n  \"held:read\",\n  'other:read',\n];\n";
    expect(appendToList(source, openAfter(source, 'a ='), ["'held:read'", "'other:read'"])).toBe(
      source,
    );
    const list = readList(source, maskOf(source), openAfter(source, 'a ='));
    if (list === undefined) return expect.unreachable('unread');
    expect(absentFrom(list, ["'held:read'", "'new:read'", "'new:read'"])).toEqual(["'new:read'"]);
  });

  test('a comment-free list is re-wrapped the way Biome prints it: one line while it fits', () => {
    const short = "  grants: ['a:read'],\n";
    expect(appendToList(short, openAfter(short, 'grants'), ["'b:read'"])).toBe(
      "  grants: ['a:read', 'b:read'],\n",
    );
    const long = `  grants: [${Array.from({ length: 9 }, (_unused, n) => `'table${n}:read'`).join(', ')}],\n`;
    const wrapped = appendToList(long, openAfter(long, 'grants'), ["'last:read'"]) ?? '';
    expect(wrapped.split('\n').every((line) => line.length <= 100)).toBe(true);
    expect(wrapped).toEndWith("    'last:read',\n  ],\n");
    expect(entriesOf(wrapped, 'grants')).toHaveLength(10);
  });

  test('a spread is an entry like any other, and survives', () => {
    const source = 'const all = definePermissions([...a.all, ...b.all]);\n';
    expect(appendToList(source, openAfter(source, 'definePermissions'), ["'x:read'"])).toBe(
      "const all = definePermissions([...a.all, ...b.all, 'x:read']);\n",
    );
  });

  test('an empty list, an empty list holding only a comment, and a one-line commented list', () => {
    expect(appendToList('const a = [];\n', 10, ["'x:read'"])).toBe("const a = ['x:read'];\n");
    const noted = "const a = [\n  // nothing yet — it's coming\n];\n";
    expect(appendToList(noted, 10, ["'x:read'"])).toBe(
      "const a = [\n  // nothing yet — it's coming\n  'x:read',\n];\n",
    );
    const inline = "const a = ['p:read' /* the firm's */];\n";
    expect(appendToList(inline, 10, ["'x:read'"])).toBe(
      "const a = ['p:read' /* the firm's */, 'x:read'];\n",
    );
  });

  test('a last entry with a comment beside it gets its comma before the comment', () => {
    const source = "const a = [\n  'p:read' // the owner's\n];\n";
    expect(appendToList(source, 10, ["'x:read'"])).toBe(
      "const a = [\n  'p:read', // the owner's\n  'x:read',\n];\n",
    );
  });

  test('a bracket that never closes is refused, never guessed at', () => {
    const source = "const a = [\n  'p:read',\n";
    expect(appendToList(source, 10, ["'x:read'"])).toBeUndefined();
    expect(closingBracket(maskOf(source), 10)).toBe(-1);
  });
});

describe('unit · the properties of an object literal, off the masked text', () => {
  test('a key named in a comment or a string is prose; a quoted key is read by its value', () => {
    const source = [
      'defineRoles({',
      "  // admin: { grants: ['never:this'] } — it's an example",
      "  note: 'admin: { grants: [] }',",
      "  'api-admin': { grants: ['a:read'] },",
      '  admin: {',
      "    grants: ['b:read'],",
      '  },',
      '  ...rest,',
      '  shorthand,',
      '});',
    ].join('\n');
    const masked = maskOf(source);
    const properties = readProperties(source, masked, source.indexOf('{'));
    expect(properties.map((one) => one.key)).toEqual(['note', 'api-admin', 'admin']);
    const admin = properties.find((one) => one.key === 'admin');
    expect(source.slice(admin?.value ?? 0, (admin?.value ?? 0) + 1)).toBe('{');
  });
});
