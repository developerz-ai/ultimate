import { describe, expect, test } from 'bun:test';
import { EffectsInvalidValueError } from '../errors';
import { revealStepMs, splitReveal } from './text-reveal-view';

const animated = (text: string, by: 'word' | 'line' | 'char', locale: string): string[] =>
  splitReveal(text, by, locale)
    .filter((p) => p.animate)
    .map((p) => p.text);

describe('splitReveal', () => {
  test('words keep the whitespace between them as unanimated pieces', () => {
    const pieces = splitReveal('Hello big world', 'word', 'en');
    expect(pieces.map((p) => p.text).join('')).toBe('Hello big world');
    expect(animated('Hello big world', 'word', 'en')).toEqual(['Hello', 'big', 'world']);
  });

  test('the locale decides where a word ends (Japanese has no spaces)', () => {
    expect(animated('今日は天気', 'word', 'ja').length).toBeGreaterThan(1);
    expect(animated('今日は天気', 'word', 'en').length).toBeGreaterThan(0);
  });

  test('a char is a grapheme: a ZWJ family and a flag stay whole', () => {
    expect(animated('a👨‍👩‍👧🇷🇴', 'char', 'en')).toEqual(['a', '👨‍👩‍👧', '🇷🇴']);
  });

  test('lines split on newlines and skip blank ones', () => {
    expect(animated('one\n\ntwo', 'line', 'en')).toEqual(['one', 'two']);
  });

  test('joined pieces always rebuild the text', () => {
    for (const by of ['word', 'line', 'char'] as const) {
      const pieces = splitReveal('a b\nc', by, 'en');
      expect(pieces.map((p) => p.text).join(by === 'line' ? '\n' : '')).toBe('a b\nc');
    }
  });
});

describe('revealStepMs', () => {
  test('a short text keeps the step', () => {
    expect(revealStepMs(5)).toBe(40);
  });
  test('a long text is squeezed under the total', () => {
    expect(revealStepMs(1001, 40, 900)).toBeCloseTo(0.9);
  });
  test('refuses a negative step', () => {
    expect(() => revealStepMs(3, -1)).toThrow(EffectsInvalidValueError);
  });
});
