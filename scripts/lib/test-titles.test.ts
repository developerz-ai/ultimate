// The titles a test file declares, read the way `vanished-tests` compares them: every `test`/`it`
// title in source order — `.each`, `.skip`/`.only`/`.todo`/`.if(…)` chains and template-literal
// titles included — and never a title inside a comment, a string, or a `describe`.

import { describe, expect, test } from 'bun:test';
import { testTitles } from './test-titles';

describe('testTitles', () => {
  test('plain, single-, double- and back-quoted titles, in source order', () => {
    const source = [
      "test('one', () => {});",
      'it("two", () => {});',
      'test(`three \x24{x}`, () => {});',
    ].join('\n');
    expect(testTitles(source)).toEqual(['one', 'two', 'three \x24{x}']);
  });

  test('modifier chains and .each in both forms, whatever their arguments hold', () => {
    const source = [
      "test.skip('a', () => {});",
      "it.only('b', () => {});",
      "test.todo('c');",
      "test.if(process.platform !== 'win32')('d', () => {});",
      "test.each([['x)', 1], ['y', 2]])('e %s', (name) => {});",
      "test.each`\n  a | b\n  \x24{1} | \x24{2}\n`('f $a', () => {});",
      "test.skipIf(Boolean(1)).each([1])('g %d', () => {});",
    ].join('\n');
    expect(testTitles(source)).toEqual(['a', 'b', 'c', 'd', 'e %s', 'f $a', 'g %d']);
  });

  test('a call with no semicolon after it, inside a describe body, still has its title', () => {
    expect(
      testTitles("describe('g', () => {\n  test.skip('a', () => {})\n  it('b', () => {})\n})"),
    ).toEqual(['a', 'b']);
  });

  test('a describe title is not a test title; a nested test is', () => {
    expect(testTitles("describe('group', () => {\n  test('inner', () => {});\n});")).toEqual([
      'inner',
    ]);
  });

  test('a title in a comment or a string is not one, nor is a property or a longer name', () => {
    const source = [
      "// test('commented', () => {});",
      "/* it('blocked', () => {}); */",
      'const s = "test(\'quoted\')";',
      "obj.test('member');",
      "latest('word');",
      "test('real', () => {});",
    ].join('\n');
    expect(testTitles(source)).toEqual(['real']);
  });

  test('escaped quotes and a template with nested braces stay one title', () => {
    expect(testTitles("test('it\\'s', () => {});")).toEqual(["it\\'s"]);
    expect(testTitles('test(`a \x24{f({ b: 1 })} c`, () => {});')).toEqual([
      'a \x24{f({ b: 1 })} c',
    ]);
  });
});
