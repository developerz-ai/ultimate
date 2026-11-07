// The keyboard-shortcut rule, driven with plain values: what a key means given the table, the
// chord in flight and where focus is. The Solid shell (`use-hotkeys.ts`) only feeds it events.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from './errors';
import {
  CHORD_WINDOW_MS,
  compileHotkeys,
  type HotkeyKeyEvent,
  type HotkeyRow,
  type HotkeyState,
  hotkeyAction,
  hotkeyKeycaps,
  IDLE_HOTKEY_STATE,
} from './hotkeys-view';

const ran: string[] = [];
const row = (keys: readonly string[], label: string): HotkeyRow => ({
  keys,
  label,
  run: () => ran.push(label),
});

const table = compileHotkeys([
  row(['mod+k'], 'palette'),
  row(['?'], 'sheet'),
  row(['g r'], 'runs'),
  row(['Escape'], 'escape'),
]);

const key = (k: string, extra: Partial<HotkeyKeyEvent> = {}): HotkeyKeyEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  editable: false,
  at: 0,
  ...extra,
});

const other: HotkeyState = { ...IDLE_HOTKEY_STATE, mac: false };
const mac: HotkeyState = { ...IDLE_HOTKEY_STATE, mac: true };

const label = (answer: ReturnType<typeof hotkeyAction>): string | undefined => answer.row?.label;

describe('hotkeyAction', () => {
  test('a bare key fires outside a field and is ignored while typing', () => {
    expect(label(hotkeyAction(key('?'), other, table))).toBe('sheet');
    expect(label(hotkeyAction(key('?', { editable: true }), other, table))).toBeUndefined();
  });

  test('a bare key never fires with a modifier held', () => {
    expect(label(hotkeyAction(key('?', { ctrlKey: true }), other, table))).toBeUndefined();
    expect(label(hotkeyAction(key('?', { metaKey: true }), other, table))).toBeUndefined();
    expect(label(hotkeyAction(key('?', { altKey: true }), other, table))).toBeUndefined();
  });

  test('IME composition is skipped, whatever the key', () => {
    expect(label(hotkeyAction(key('?', { isComposing: true }), other, table))).toBeUndefined();
    expect(
      label(hotkeyAction(key('k', { ctrlKey: true, isComposing: true }), other, table)),
    ).toBeUndefined();
  });

  test('mod+k needs the platform modifier, and fires while typing', () => {
    expect(label(hotkeyAction(key('k', { ctrlKey: true }), other, table))).toBe('palette');
    expect(label(hotkeyAction(key('k', { metaKey: true }), mac, table))).toBe('palette');
    expect(label(hotkeyAction(key('k', { ctrlKey: true, editable: true }), other, table))).toBe(
      'palette',
    );
    // The other platform's modifier, or none at all, is not `mod`.
    expect(label(hotkeyAction(key('k', { metaKey: true }), other, table))).toBeUndefined();
    expect(label(hotkeyAction(key('k'), other, table))).toBeUndefined();
    expect(
      label(hotkeyAction(key('k', { ctrlKey: true, altKey: true }), other, table)),
    ).toBeUndefined();
  });

  test('Escape is allowed while typing', () => {
    expect(label(hotkeyAction(key('Escape', { editable: true }), other, table))).toBe('escape');
  });

  test('a chord fires inside its window and not past it', () => {
    const first = hotkeyAction(key('g', { at: 100 }), other, table);
    expect(first.row).toBeUndefined();
    expect(first.state.pending).toBe('g');
    expect(label(hotkeyAction(key('r', { at: 100 + CHORD_WINDOW_MS }), first.state, table))).toBe(
      'runs',
    );
    const late = hotkeyAction(key('r', { at: 101 + CHORD_WINDOW_MS }), first.state, table);
    expect(late.row).toBeUndefined();
    expect(late.state.pending).toBeNull();
  });

  test('a chord is reset by a non-matching key, which is then read on its own', () => {
    const first = hotkeyAction(key('g', { at: 0 }), other, table);
    const second = hotkeyAction(key('?', { at: 10 }), first.state, table);
    expect(label(second)).toBe('sheet');
    expect(second.state.pending).toBeNull();
  });

  test('a chord does not start while typing', () => {
    expect(hotkeyAction(key('g', { editable: true }), other, table).state.pending).toBeNull();
  });
});

describe('compileHotkeys', () => {
  const refuses = (rows: readonly HotkeyRow[], needle: string): void => {
    try {
      compileHotkeys(rows);
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe(UI_ERROR_CODES.invalidValue);
      expect(String((error as { cause?: unknown }).cause)).toContain(needle);
      return;
    }
    expect.unreachable(`compileHotkeys accepted ${needle}`);
  };

  test('a binding twice, a chord over two keys, a prefix clash and an empty key are refused', () => {
    refuses([row(['?'], 'a'), row(['?'], 'b')], '"?"');
    refuses([row(['g r x'], 'a')], 'g r x');
    refuses([row(['g'], 'a'), row(['g r'], 'b')], '"g"');
    refuses([row([''], 'a')], '""');
    refuses([row(['mod+g r'], 'a')], 'mod+g r');
    refuses([row([], 'a')], 'no keys');
  });
});

describe('hotkeyKeycaps', () => {
  test('mod reads as the platform key, a chord as its steps, Escape as Esc', () => {
    expect(hotkeyKeycaps('mod+k', true)).toEqual([['⌘', 'K']]);
    expect(hotkeyKeycaps('mod+k', false)).toEqual([['Ctrl', 'K']]);
    expect(hotkeyKeycaps('g r', false)).toEqual([['g'], ['r']]);
    expect(hotkeyKeycaps('Escape', false)).toEqual([['Esc']]);
  });
});
