// Which changes to a declaration every caller survives: an optional member, an optional trailing
// parameter, a parameter that accepts more, a literal set that grew, a read-only value or class that
// gained members, a local that changed compatibly. Everything else — and anything unknown — breaks.

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

  // A `type F = (…) => R` is as often a callback the app IMPLEMENTS as a function it calls, and
  // for an implementation both a widened parameter and a new optional property are compile breaks
  // under `--strict` (its parameter no longer accepts what is passed). So its parameters are held
  // unchanged — `members()`' strictness — and only a function or const declaration accepts more.
  test('a function type alias holds its parameters unchanged: more accepted is a break', () => {
    const before =
      'type Build = ( root : string , o ? : { readonly only ? : string ; } ) => Promise < B >';
    expect(
      verdict(before, before.replace('only ? : string ;', 'only ? : string ; c ? : boolean ;')),
    ).toBe(
      'break: a function type an app may implement: parameter 2 changed (it accepts more properties)',
    );
    expect(verdict(before, before.replace('root : string', 'root : string | URL'))).toBe(
      'break: a function type an app may implement: parameter 1 changed (it accepts more)',
    );
    expect(verdict(before, before.replace('Promise < B >', 'B'))).toBe(
      'break: its return type changed',
    );
  });

  test('a function type alias: a renamed parameter or a new optional one is still compatible', () => {
    const before = 'type Hook = ( event : E ) => void';
    expect(verdict(before, 'type Hook = ( e : E ) => void')).toBe(
      'compatible: parameters renamed only',
    );
    // An implementation that ignores a trailing parameter still type-checks against the new one.
    expect(verdict(before, 'type Hook = ( event : E , at ? : number ) => void')).toBe(
      'compatible: optional parameter 2 added',
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

describe('public-api-compat · literal sets', () => {
  test('a literal union that only grew is compatible; one that lost a literal is a break', () => {
    expect(verdict('type Mode = "a" | "b"', 'type Mode = "a" | "b" | "c"')).toBe(
      'compatible: 1 literal(s) added — an exhaustive switch over it gains a case',
    );
    expect(verdict('type Mode = "a" | "b"', 'type Mode = "a"')).toBe(
      'break: 1 literal(s) were removed from the set',
    );
  });

  test('`keyof typeof` a local object is the set of its keys', () => {
    const codes = (keys: string) => `type Code = keyof typeof T\nlocal const T : { ${keys} }`;
    const before = codes('readonly A : "x" ;');
    expect(verdict(before, codes('readonly A : "x" ; readonly B : "y" ;'))).toContain(
      'compatible: 1 literal(s) added',
    );
    expect(verdict(before, codes('readonly A : "retitled" ;'))).toBe(
      'compatible: literals reordered only',
    );
    expect(verdict(before, codes('readonly B : "y" ;'))).toContain('break: 1 literal(s)');
  });

  test('a readonly literal tuple that gained a row is compatible, one that lost one is not', () => {
    const before = 'const NAMES : readonly [ "a" , "b" ]';
    expect(verdict(before, 'const NAMES : readonly [ "a" , "z" , "b" ]')).toContain('compatible');
    expect(verdict(before, 'const NAMES : readonly [ "a" ]')).toContain('break');
  });
});

describe('public-api-compat · values and classes, read by callers', () => {
  test('a const object that gained a member, required or not, is compatible', () => {
    const before = 'const S : { readonly A : 404 ; }';
    expect(verdict(before, 'const S : { readonly A : 404 ; readonly B : 409 ; }')).toBe(
      'compatible: `B` added to a value callers only read',
    );
    expect(verdict(before, 'const S : { readonly A : 500 ; }')).toBe(
      'break: member `A` changed its type',
    );
    expect(verdict(before, 'const S : { }')).toBe('break: member `A` was removed');
  });

  const ERR = 'class E extends B { readonly a : 1 ; constructor ( init : { m : string ; } ) ; }';

  test('a class that gained members and an optional constructor property is compatible', () => {
    const after = ERR.replace('readonly a : 1 ;', 'readonly a : 1 ; readonly b : 2 ;').replace(
      'm : string ;',
      'm : string ; f ? : number ;',
    );
    expect(verdict(ERR, after)).toBe(
      'compatible: `b` added to a value callers only read; constructor: parameter 1 accepts more properties',
    );
  });

  test('a class whose constructor needs more, or that lost a member, is a break', () => {
    expect(verdict(ERR, ERR.replace('m : string ;', 'm : string ; f : number ;'))).toBe(
      'break: its constructor: parameter 1 gained required property `f`',
    );
    expect(verdict(ERR, ERR.replace(' readonly a : 1 ;', ''))).toBe(
      'break: member `a` was removed',
    );
  });
});

describe('public-api-compat · object-literal parameters', () => {
  const OPEN = 'function open ( o : { a : string ; } ) : void';

  test('a new optional property is compatible; a new required or a removed one is a break', () => {
    expect(verdict(OPEN, OPEN.replace('a : string ;', 'a : string ; b ? : 1 ;'))).toBe(
      'compatible: parameter 1 accepts more properties',
    );
    expect(verdict(OPEN, OPEN.replace('a : string ;', 'a : string ; b : 1 ;'))).toBe(
      'break: parameter 1 gained required property `b`',
    );
    expect(verdict(OPEN, OPEN.replace('a : string ;', 'b ? : 1 ;'))).toBe(
      'break: parameter 1 property `a` was removed',
    );
  });
});

describe('public-api-compat · declarations', () => {
  const SPEC = 'type S = F & ( { a : 1 ; } | { b : 1 ; } )';

  test('a local interface that gained an optional member is compatible', () => {
    expect(
      verdict(
        `${SPEC}\nlocal interface F { c : 1 ; }`,
        `${SPEC}\nlocal interface F { c : 1 ; d ? : 2 ; }`,
      ),
    ).toBe('compatible: local `F`: optional `d` added');
  });

  test('a local that needs more, or a changed own text, is a break', () => {
    const before = `${SPEC}\nlocal interface F { c : 1 ; }`;
    expect(verdict(before, `${SPEC}\nlocal interface F { c : 1 ; d : 2 ; }`)).toBe(
      'break: the local type `F` it names: required member `d` was added',
    );
    expect(verdict(before, before.replace('b : 1', 'b : 2'))).toContain(
      'break: its type declaration changed',
    );
  });

  test('a removed overload, and a change of kind, are breaks', () => {
    const overloads = 'function f ( a : 1 ) : void\nfunction f ( a : 2 ) : void';
    expect(verdict(overloads, 'function f ( a : 1 ) : void')).toContain('break');
    expect(verdict('type S = { a : 1 ; }', 'function S ( ) : void')).toContain('break');
  });

  test('a recorded bare hash, or an unrecorded shape, judges any change a break', () => {
    const after = symbol(OPTIONS.replace('; }', '; readonly label ? : string ; }'));
    const why = 'its declaration changed, and the lock holds no shape to judge the change by';
    expect(classify({ hash: symbol(OPTIONS).hash }, after)).toEqual({ kind: 'break', why });
    expect(classify({ hash: symbol(OPTIONS).hash, shape: { kind: 'unrecorded' } }, after)).toEqual({
      kind: 'break',
      why,
    });
  });
});

describe('public-api-compat · inherited members', () => {
  const BEFORE = 'interface Target extends Arm { readonly browser : B ; }';
  const PARENT = 'inherits interface Arm { readonly page : P ; readonly clock : C ; }';

  test('a member its `extends` parent already requires, re-declared the same, is no new requirement', () => {
    const after = `${BEFORE.replace('{', '{ readonly page : P ;')}\n${PARENT}`;
    expect(verdict(`${BEFORE}\n${PARENT}`, after)).toBe(
      'compatible: `page` re-declared as its parent `Arm` requires it',
    );
  });

  test('re-declared with another type, or required and in no parent, is still a break', () => {
    expect(verdict(BEFORE, `${BEFORE.replace('{', '{ readonly page : Q ;')}\n${PARENT}`)).toBe(
      'break: required member `page` was added',
    );
    expect(verdict(BEFORE, BEFORE.replace('{', '{ readonly page : P ;'))).toBe(
      'break: required member `page` was added',
    );
  });
});

describe('public-api-compat · overloads', () => {
  const MAP = 'function map < T > ( items : readonly T [ ] , o : O ) : Promise < T [ ] >';
  const ALL =
    'function map < T > ( items : readonly T [ ] , o : O & { settle : "all" ; } ) : Promise < S [ ] >';

  test('a function that gained overloads, its old call shape still matched, is compatible', () => {
    expect(verdict(MAP, `${ALL}\n${MAP}`)).toBe(
      'compatible: every recorded call shape still matches an overload with the same return',
    );
  });

  test('an old call shape matched only by an overload with a widened return is a break', () => {
    const widened = MAP.replace('Promise < T [ ] >', 'Promise < T [ ] | S [ ] >');
    expect(verdict(MAP, `${ALL}\n${widened}`)).toBe(
      'break: the recorded call shape matches no overload with the same return — closest: its return type changed',
    );
  });

  // TypeScript resolves a call against the FIRST overload whose parameters accept it: a wider
  // overload put in front answers every existing call with its own return type.
  test('a wider overload in front of a recorded one changes its calls: a break', () => {
    const one = 'function f ( x : string ) : string';
    const wider = 'function f ( x : string | number ) : number';
    expect(verdict(one, `${wider}\n${one}`)).toBe(
      'break: the recorded call shape is answered first by an overload with another return',
    );
    expect(verdict(one, `${one}\n${wider}`)).toBe(
      'compatible: every recorded call shape still matches an overload with the same return',
    );
  });

  test('an overload removed from a set is a break; one added is compatible', () => {
    const two = `${ALL}\n${MAP}`;
    expect(verdict(two, MAP)).toContain('break: the recorded call shape');
    expect(verdict(two, `${two}\nfunction map ( ) : void`)).toBe(
      'compatible: every recorded call shape still matches an overload with the same return',
    );
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
