// A chord is the caller's own literal, so the grammar is the whole check — and the frames are what
// a real keyboard would send, because the page listens for `metaKey`, not for a letter.
import { describe, expect, test } from 'bun:test';
import { characterFrames, chordFrames, keyDefinition, parseKeyChord } from './cdp-shot-keys';

describe('unit · a key chord is refused before any key goes down', () => {
  test.each([
    ['', 'is empty'],
    ['Meta+', "ends in '+'"],
    ['Ctrl+K', '"Ctrl"'],
    ['Shift+Shift+A', 'twice'],
    ['Meta+Return', '"Return"'],
  ])('%p is X_SHOT_KEY_INVALID', (chord, named) => {
    let thrown: unknown;
    try {
      parseKeyChord(chord);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_SHOT_KEY_INVALID');
    expect((thrown as { cause: string }).cause).toContain(named);
  });
});

describe('unit · the frames a real keyboard sends', () => {
  test('Meta+K holds Meta, presses K with no text, and releases in reverse', () => {
    const frames = chordFrames(parseKeyChord('Meta+K'));
    expect(frames.map((f) => [f['type'], f['key'], f['modifiers'], f['text']])).toEqual([
      ['rawKeyDown', 'Meta', 4, undefined],
      ['rawKeyDown', 'K', 4, undefined],
      ['keyUp', 'K', 4, undefined],
      ['keyUp', 'Meta', 0, undefined],
    ]);
    expect(frames[1]?.['code']).toBe('KeyK');
    expect(frames[1]?.['windowsVirtualKeyCode']).toBe(75);
  });

  test('Shift alone still types: Shift+A carries its text', () => {
    const frames = chordFrames(parseKeyChord('Shift+A'));
    expect(frames[1]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 });
  });

  test('Enter types a carriage return, which is what submits a form', () => {
    const [down] = chordFrames(parseKeyChord('Enter'));
    expect(down).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      text: '\r',
      windowsVirtualKeyCode: 13,
    });
  });

  test('Escape, Tab and the arrows are named keys with codes and no text', () => {
    for (const [name, code] of [
      ['Escape', 27],
      ['Tab', 9],
      ['ArrowDown', 40],
      ['F5', 116],
    ] as const) {
      expect(keyDefinition(name)).toMatchObject({ key: name, keyCode: code });
      expect(keyDefinition(name)?.text).toBeUndefined();
    }
  });

  test('a character outside the named set still types itself', () => {
    expect(characterFrames('é')).toEqual([
      expect.objectContaining({ type: 'keyDown', text: 'é' }),
      expect.objectContaining({ type: 'keyUp', key: 'é' }),
    ]);
  });
});
