import { describe, expect, test } from 'bun:test';
import { retryFor } from '@ultimat3/core';
import { KEY_MODIFIERS, parseKeyChord } from './key-chord';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · parseKeyChord', () => {
  test('a bare key has no modifiers', () => {
    expect(parseKeyChord('Enter')).toEqual({ modifiers: [], key: 'Enter' });
  });

  test('modifiers are read in the order written, then the key', () => {
    expect(parseKeyChord('Meta+K')).toEqual({ modifiers: ['Meta'], key: 'K' });
    expect(parseKeyChord('Control+Shift+P')).toEqual({
      modifiers: ['Control', 'Shift'],
      key: 'P',
    });
  });

  test('every declared modifier parses', () => {
    for (const modifier of KEY_MODIFIERS) {
      expect(parseKeyChord(`${modifier}+a`).modifiers).toEqual([modifier]);
    }
  });

  test('an unknown modifier is X_SCRAPE_KEY_INVALID — Ctrl is not Control', () => {
    expect(codeOf(() => parseKeyChord('Ctrl+K'))).toBe('X_SCRAPE_KEY_INVALID');
    expect(codeOf(() => parseKeyChord('meta+K'))).toBe('X_SCRAPE_KEY_INVALID');
  });

  test("a trailing '+' and an empty chord are refused", () => {
    expect(codeOf(() => parseKeyChord('Meta+'))).toBe('X_SCRAPE_KEY_INVALID');
    expect(codeOf(() => parseKeyChord('+'))).toBe('X_SCRAPE_KEY_INVALID');
    expect(codeOf(() => parseKeyChord(''))).toBe('X_SCRAPE_KEY_INVALID');
  });

  test('a modifier held twice is refused', () => {
    expect(codeOf(() => parseKeyChord('Shift+Shift+A'))).toBe('X_SCRAPE_KEY_INVALID');
  });

  test('the cause names the offending segment and the fix names the grammar', () => {
    let thrown: { cause?: string; fix?: string } = {};
    try {
      parseKeyChord('Cmd+K');
    } catch (caught) {
      thrown = caught as { cause?: string; fix?: string };
    }
    expect(thrown.cause).toContain('"Cmd"');
    expect(thrown.fix).toContain('Meta, Control, Alt, Shift');
  });

  test('the code is registered TERMINAL — the chord is the caller’s own literal', () => {
    expect(retryFor('X_SCRAPE_KEY_INVALID')).toBe('terminal');
  });
});
