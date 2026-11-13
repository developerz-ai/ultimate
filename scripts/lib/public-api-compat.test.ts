// Which changes to a declaration every caller survives: an optional member, an optional trailing
// parameter, a parameter that accepts more. Everything else — and anything unknown — is a break.

import { describe, expect, test } from 'bun:test';
import type { ApiSymbol } from './public-api-compat';
import { classify } from './public-api-compat';
import { symbolsOf } from './public-api-surface';

const symbol = (text: string): ApiSymbol => {
  const one = symbolsOf({ x: text })['x'];
  if (one === undefined) return expect.unreachable('symbolsOf keeps every name');
  return one;
};

const verdict = (before: string, after: string): string => {
  const change = classify(symbol(before), symbol(after));
  return change.kind === 'same' ? 'same' : `${change.kind}: ${change.why}`;
};

const OPTIONS = 'interface Options { readonly url : string ; readonly retries ? : number ; }';
const RENDER = 'function render ( width : number , mode : "a" | "b" ) : string';

describe('public-api-compat · interfaces and object types', () => {
  test('unchanged is nothing', () => {
    expect(verdict(OPTIONS, OPTIONS)).toBe('same');
  });

  test('a new optional member is compatible, named', () => {
    const after = OPTIONS.replace('; }', '; readonly label ? : string ; }');
    expect(verdict(OPTIONS, after)).toBe('compatible: optional `label` added');
  });

  test('a new optional method is compatible', () => {
    const after = OPTIONS.replace('; }', '; send ? ( command : string ) : void ; }');
    expect(verdict(OPTIONS, after)).toBe('compatible: optional `send` added');
  });

  test('a new required member is a break: the interface may be an input', () => {
    const after = OPTIONS.replace('; }', '; readonly label : string ; }');
    expect(verdict(OPTIONS, after)).toBe('break: required member `label` was added');
  });

  test('an optional member made required is a break', () => {
    const after = OPTIONS.replace('retries ? :', 'retries :');
    expect(verdict(OPTIONS, after)).toBe('break: member `retries` became required');
  });

  test('a required member made optional is a break: the interface may be an output', () => {
    const after = OPTIONS.replace('url :', 'url ? :');
    expect(verdict(OPTIONS, after)).toContain('break: member `url` became optional');
  });

  test('a removed member and a changed member type are breaks', () => {
    expect(verdict(OPTIONS, OPTIONS.replace(' readonly retries ? : number ;', ''))).toBe(
      'break: member `retries` was removed',
    );
    expect(verdict(OPTIONS, OPTIONS.replace('url : string', 'url : URL'))).toBe(
      'break: member `url` changed its type',
    );
  });

  test('a changed heading — extends, type parameters — is a break', () => {
    const after = OPTIONS.replace('Options {', 'Options extends Base {');
    expect(verdict(OPTIONS, after)).toContain('break: its heading changed');
  });

  test('a local type the declaration names is part of its heading', () => {
    const before = `${OPTIONS}\nlocal interface Base { a : 1 ; }`;
    expect(verdict(before, `${OPTIONS}\nlocal interface Base { a : 2 ; }`)).toContain(
      'break: its heading changed',
    );
  });

  test('a type alias of an object type is classified the same way', () => {
    const before = 'type Style = { color : string ; }';
    expect(verdict(before, 'type Style = { color : string ; weight ? : number ; }')).toBe(
      'compatible: optional `weight` added',
    );
  });
});

describe('public-api-compat · functions', () => {
  test('a new optional trailing parameter is compatible', () => {
    const after = RENDER.replace(') :', ', options ? : { a : 1 ; } ) :');
    expect(verdict(RENDER, after)).toBe('compatible: optional parameter 3 added');
  });

  test('a new required parameter is a break', () => {
    const after = RENDER.replace(') :', ', options : { a : 1 ; } ) :');
    expect(verdict(RENDER, after)).toBe('break: required parameter 3 was added');
  });

  test('a widened union in a parameter is compatible; a narrowed one is a break', () => {
    expect(verdict(RENDER, RENDER.replace('"b"', '"b" | "c"'))).toBe(
      'compatible: parameter 2 accepts more',
    );
    expect(verdict(RENDER, RENDER.replace(' | "b"', ''))).toContain('break: parameter 2 changed');
  });

  test('a widened return type is a break, and so is any changed return', () => {
    expect(verdict(RENDER, RENDER.replace(': string', ': string | number'))).toBe(
      'break: its return type changed',
    );
  });

  test('a removed parameter, or an optional one made required, is a break', () => {
    expect(verdict(RENDER, 'function render ( width : number ) : string')).toBe(
      'break: parameter 2 was removed',
    );
    const optional = RENDER.replace('mode :', 'mode ? :');
    expect(verdict(optional, RENDER)).toBe('break: parameter 2 became required');
    expect(verdict(RENDER, optional)).toBe('compatible: parameter 2 became optional');
  });

  test('a renamed parameter is compatible: no caller names it', () => {
    expect(verdict(RENDER, RENDER.replace('width', 'size'))).toBe(
      'compatible: parameters renamed only',
    );
  });

  test('a const arrow type is a function: an optional trailing parameter is compatible', () => {
    const before = 'const make : < T > ( seed : T ) => T';
    expect(verdict(before, 'const make : < T > ( seed : T , salt ? : string ) => T')).toBe(
      'compatible: optional parameter 2 added',
    );
  });

  test('an arrow type in a parameter is one member, never split at its return union', () => {
    const before = 'function on ( cb : ( a : A ) => B ) : void';
    expect(verdict(before, 'function on ( cb : ( a : A ) => B | C ) : void')).toContain(
      'break: parameter 1 changed',
    );
  });
});

describe('public-api-compat · no shape, no judgement', () => {
  test('a class, a union alias or overloads change as a break', () => {
    expect(verdict('class A { x : 1 ; }', 'class A { x : 1 ; y ? : 2 ; }')).toContain('break');
    expect(verdict('type Mode = "a" | "b"', 'type Mode = "a" | "b" | "c"')).toContain('break');
    const overloads = 'function f ( a : 1 ) : void\nfunction f ( a : 2 ) : void';
    expect(verdict(overloads, `${overloads}\nfunction f ( a : 3 ) : void`)).toContain('break');
  });

  test('a recorded bare hash (a format-1 lock) judges any change a break', () => {
    const after = symbol(OPTIONS.replace('; }', '; readonly label ? : string ; }'));
    expect(classify({ hash: symbol(OPTIONS).hash }, after)).toEqual({
      kind: 'break',
      why: 'its declaration changed, and the lock holds no shape to judge the change by',
    });
  });

  test('a change of kind is a break', () => {
    expect(verdict('type S = { a : 1 ; }', 'function S ( ) : void')).toContain('break');
  });
});

describe('public-api-compat · member names', () => {
  test("a member named like an Object.prototype key is the interface's own", () => {
    const before = 'interface A { toString ( ) : string ; __proto__ : number ; }';
    expect(verdict(before, 'interface A { __proto__ : number ; }')).toBe(
      'break: member `toString` was removed',
    );
    expect(verdict('interface A { }', 'interface A { constructor ? : 1 ; }')).toBe(
      'compatible: optional `constructor` added',
    );
  });
});
