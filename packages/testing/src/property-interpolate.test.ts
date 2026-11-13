// Property: `interpolate` agrees with a model built from the template's own pieces — literal
// text, `{{`/`}}` escapes, known and unknown variables, and names an object only inherits.

import { describe, expect, test } from 'bun:test';
import { interpolate } from '@ultimat3/i18n';
import { property } from './property';
import { gen } from './property-gen';

type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'open' }
  | { readonly kind: 'close' }
  | { readonly kind: 'var'; readonly name: string };

const VARS: Readonly<Record<string, string | number | boolean>> = {
  name: 'Ada',
  count: 3,
  on: false,
  x: '{y}',
};
const NAMES = [
  'name',
  'count',
  'on',
  'x',
  'missing',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
] as const;
const TEXT_CHARS = ['a', ' ', 'é', '漢', '🙂', '$', '&', '\n', '⟦'] as const;

const piece = gen.union<Piece>([
  gen.map(gen.string({ minLength: 1, maxLength: 5, chars: gen.oneOf(TEXT_CHARS) }), (text) => ({
    kind: 'text',
    text,
  })),
  gen.constant({ kind: 'open' }),
  gen.constant({ kind: 'close' }),
  gen.map(gen.oneOf(NAMES), (name) => ({ kind: 'var', name })),
]);

const source = (p: Piece): string =>
  p.kind === 'text' ? p.text : p.kind === 'open' ? '{{' : p.kind === 'close' ? '}}' : `{${p.name}}`;

const rendered = (p: Piece): string => {
  if (p.kind === 'text') return p.text;
  if (p.kind === 'open') return '{';
  if (p.kind === 'close') return '}';
  return Object.hasOwn(VARS, p.name) ? String(VARS[p.name]) : `⟦${p.name}⟧`;
};

describe('interpolate properties', () => {
  test('a template renders as its pieces do, one by one', () => {
    property(
      gen.array(piece, { maxLength: 10 }),
      (pieces) => {
        expect(interpolate(pieces.map(source).join(''), VARS)).toBe(pieces.map(rendered).join(''));
      },
      { runs: 500 },
    );
  });

  test('a substituted value is never interpolated again', () => {
    property(gen.string({ maxLength: 12 }), (value) => {
      expect(interpolate('<{v}>', { v: value })).toBe(`<${value}>`);
    });
  });
});
