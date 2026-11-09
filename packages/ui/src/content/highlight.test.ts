// The tokenizer's one promise, as a property: for every built-in language, on hostile text, the
// joined runs equal the input byte for byte. Plus the rules a language is held to.

import { describe, expect, test } from 'bun:test';
import { defineLanguage, findLanguage, highlight, TOKEN_KINDS } from './highlight';
import { allLanguages } from './languages/all';
import { tsLanguage } from './languages/ts';

/** A seeded generator, so a failure names a reproducible case. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const ALPHABET = [
  ...'abcxyzAZ019 \t\n\r"\'`\\/*#-+@$<>=!:;{}[](),._|&?%~^',
  '<!--',
  '-->',
  '/*',
  '*/',
  '${',
  '\u0000',
  '\u001b[31m',
  'é',
  '😀',
  '‮',
  'const ',
  'select ',
];

function hostile(next: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
  return out;
}

describe('highlight', () => {
  for (const language of allLanguages) {
    test(`${language.name}: joined runs equal the input, on 300 hostile strings`, () => {
      const next = random(language.name.length * 7919);
      for (let round = 0; round < 300; round += 1) {
        const text = hostile(next, Math.floor(next() * 120));
        const tokens = highlight(text, language);
        expect(tokens.map((token) => token.text).join('')).toBe(text);
        for (const token of tokens) {
          expect(token.text.length).toBeGreaterThan(0);
          expect(TOKEN_KINDS).toContain(token.kind);
        }
      }
    });

    test(`${language.name}: 100 KB of openers runs in linear time`, () => {
      const text = '/*"\'`<!--${[#'.repeat(8_000);
      const began = performance.now();
      const tokens = highlight(text, language);
      expect(tokens.map((token) => token.text).join('')).toBe(text);
      expect(performance.now() - began).toBeLessThan(1_500);
    });
  }

  test('an unknown language is one plain run', () => {
    expect(highlight('const x = 1', undefined)).toEqual([{ kind: 'plain', text: 'const x = 1' }]);
    expect(highlight('', undefined)).toEqual([]);
  });

  test('ts classes the parts a reader scans for', () => {
    const kinds = highlight('const a = "s"; // c', tsLanguage).map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toContain('keyword:const');
    expect(kinds).toContain('string:"s"');
    expect(kinds).toContain('comment:// c');
  });

  test('a keyword inside an identifier is not a keyword', () => {
    const tokens = highlight('constant', tsLanguage);
    expect(tokens).toEqual([{ kind: 'plain', text: 'constant' }]);
  });

  test('defineLanguage refuses a rule that can match empty, naming it', () => {
    try {
      defineLanguage('bad', [{ kind: 'keyword', pattern: /a*/ }]);
      expect.unreachable('an empty-matching rule was accepted');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_UI_INVALID_VALUE');
      expect(String((error as { cause?: unknown }).cause)).toContain('a*');
    }
  });

  test('findLanguage reads a fence info string by name or alias, only among those passed', () => {
    expect(findLanguage('typescript title="x"', allLanguages)?.name).toBe('ts');
    expect(findLanguage('SH', allLanguages)?.name).toBe('shell');
    expect(findLanguage('ts', [])).toBeUndefined();
    expect(findLanguage('ts', undefined)).toBeUndefined();
  });
});
