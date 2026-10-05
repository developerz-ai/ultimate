// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a string is the case under test
//
// Where a `fix` value is, read off masked code: the `fix:` key, the `fix` argument of a factory,
// and the `const`s already bound to a screening call. The rule's own suite drives these through
// `scanFixShellArgs`; this one pins the pass on its own, so a regression names the pass it is in.

import { describe, expect, test } from 'bun:test';
import { maskToCode, valueEnd } from '../error-render';
import { fixParamsOf, fixSpans, screenedConsts } from './fix-shell-arg-sinks';

const masked = (source: string): string => maskToCode(source).code;

describe('fixParamsOf', () => {
  test('an exported factory names the position of its fix parameter', () => {
    const code = masked('export const failed = (key: string, cause: unknown, fix: string) => 1;');
    expect([...(fixParamsOf(valueEnd, [code]).get('failed') ?? [])]).toEqual([2]);
  });

  test('a function declaration counts, and readonly/rest prefixes are read through', () => {
    const code = masked('export function refuse(readonly fix: string) { return fix; }');
    expect([...(fixParamsOf(valueEnd, [code]).get('refuse') ?? [])]).toEqual([0]);
  });

  test('a private factory, or one with no fix parameter, is not a sink anywhere else', () => {
    const code = masked(
      'const own = (fix: string) => fix;\nexport const other = (cause: string) => 1;',
    );
    expect(fixParamsOf(valueEnd, [code]).size).toBe(0);
  });
});

describe('a class whose constructor takes a fix', () => {
  // Security audit of plan 101 sweep 1c, M1: 52 error classes take `(cause, fix)` positionally, and
  // `new XError(c, \`x … ${raw}\`)` was never read because only functions were declarations.
  test('is a sink at the constructor parameter position, exported or local', () => {
    const code = masked(
      [
        'export class XError extends UltimateError {',
        '  readonly kind = 1;',
        '  method(fix: string) { return fix; }',
        '  constructor(cause: string, public readonly fix: string) { super({ cause, fix }); }',
        '}',
      ].join('\n'),
    );
    expect([...(fixParamsOf(valueEnd, [code]).get('XError') ?? [])]).toEqual([1]);
  });

  test('a class taking an object, or with no constructor, is not', () => {
    const code = masked(
      'export class A { constructor(input: { fix: string }) {} }\nexport class B { go(fix: string) {} }',
    );
    expect(fixParamsOf(valueEnd, [code]).size).toBe(0);
  });
});

describe('fixSpans', () => {
  test('the fix argument of a call is a span; the other arguments are not', () => {
    const factory = masked('export const failed = (key: string, fix: string) => 1;');
    const source = 'failed(`${a}`, `${b}`);';
    const code = masked(source);
    const spans = fixSpans(valueEnd, code, fixParamsOf(valueEnd, [factory]));
    expect(spans.map(([start, end]) => source.slice(start, end).trim())).toEqual(['`${b}`']);
  });

  test('a local declaration of the same name decides where its fix is', () => {
    const elsewhere = masked('export const finding = (cause: string, fix: string) => 1;');
    const source =
      'const finding = (code: string, cause: string, fix: string) => 1;\nfinding(a, b, c);';
    const code = masked(source);
    const spans = fixSpans(valueEnd, code, fixParamsOf(valueEnd, [elsewhere]));
    // `fix: string` in the declaration is a `fix:` key too — a span holding no substitution.
    const read = spans.map(([start, end]) => source.slice(start, end).trim());
    expect(read).toContain('c');
    expect(read).not.toContain('b');
  });
});

describe('screenedConsts', () => {
  const covers = (source: string, name: string, marker: string): boolean =>
    screenedConsts(valueEnd, masked(source))(name, source.indexOf(marker));

  test('a const bound to a screening call covers its own block, from the binding on', () => {
    const source = 'function a() { const uri = renderFixShellArg(raw, "<u>"); use(uri /*HERE*/); }';
    expect(covers(source, 'uri', '/*HERE*/')).toBe(true);
  });

  // Security audit of plan 101 sweep 1c, L2: trust was per FILE, so a screened `uri` in one function
  // vouched for an unscreened `uri` in the next.
  test('it does not cover a same-named binding in another function', () => {
    const source = [
      'function a() { const uri = renderFixShellArg(raw, "<u>"); }',
      'function b(uri: string) { use(uri /*HERE*/); }',
    ].join('\n');
    expect(covers(source, 'uri', '/*HERE*/')).toBe(false);
  });

  test('only a screening call, and nothing after it — and never renderFixLiteral', () => {
    const source = [
      'const tail = renderFixShellArg(raw, "<u>") + rest;',
      'const plain = raw;',
      'const json = renderFixLiteral(raw, "<u>");',
      'use(tail, plain, json /*HERE*/);',
    ].join('\n');
    for (const name of ['tail', 'plain', 'json'])
      expect(covers(source, name, '/*HERE*/')).toBe(false);
  });
});
