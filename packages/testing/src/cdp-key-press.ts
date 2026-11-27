// One key press as `Input.dispatchKeyEvent` sends it: a chord (`Shift+Tab`, `Control+k`) parsed by
// `@ultimat3/scraping`'s one grammar, its key looked up, and the down and up events built — the
// modifiers as CDP's bitmask, the text a US keyboard would type, or none under Control/Meta/Alt.

import { type KeyModifier, parseKeyChord } from '@ultimat3/scraping';
import { CdpCallFailedError } from '@ultimat3/scraping/cdp';

/** Named keys `press()` knows, with the Windows virtual key code Chrome routes them by. */
export const PRESS_KEYS: Readonly<Record<string, number>> = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Backspace: 8,
  Delete: 46,
};

/** The key code of a printable character: its upper-case code point for a letter or digit. */
const charCode = (key: string): number | undefined =>
  key.length === 1 && /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined;

/**
 * The text a key TYPES, as puppeteer's key table has it. A key with text goes down as `keyDown`
 * carrying it, so Chrome raises the character event — what makes Enter submit a focused button's
 * form. A key with none (Tab, the arrows) goes down as `rawKeyDown`.
 */
const typedText = (key: string): string | undefined =>
  key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;

/** `KeyboardEvent.code`: `KeyA`, `Digit7`, `Space`; a named key is its own code. */
const keyCodeName = (key: string): string =>
  key === ' '
    ? 'Space'
    : /^[a-z]$/i.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key;

/** CDP's `modifiers` bits (`Input.dispatchKeyEvent`). */
const MODIFIER_BITS: ReadonlyMap<KeyModifier, number> = new Map([
  ['Alt', 1],
  ['Control', 2],
  ['Meta', 4],
  ['Shift', 8],
]);

/** What Shift turns a digit into on a US layout; its `code` and key code stay the digit's. */
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** The key Shift makes of `base`: an upper-case letter, a digit's symbol, else `base` itself. */
const shifted = (base: string): string =>
  /^[a-z]$/.test(base)
    ? base.toUpperCase()
    : /^[0-9]$/.test(base)
      ? (SHIFTED_DIGITS[Number(base)] ?? base)
      : base;

export interface KeyEvents {
  readonly down: Record<string, unknown>;
  readonly up: Record<string, unknown>;
}

/**
 * The two events one press sends. A chord's grammar is refused as `X_SCRAPE_KEY_INVALID`; a key
 * outside `PRESS_KEYS`, an ASCII letter or a digit as `X_CDP_CALL_FAILED`.
 */
export function keyEvents(chord: string): KeyEvents {
  const parsed = parseKeyChord(chord);
  const base = parsed.key;
  const code = (Object.hasOwn(PRESS_KEYS, base) ? PRESS_KEYS[base] : undefined) ?? charCode(base);
  if (code === undefined) {
    throw new CdpCallFailedError({
      method: `press(${chord})`,
      detail: `not a key press() knows: one of ${Object.keys(PRESS_KEYS).join(', ')}, or one ASCII letter or digit, optionally after Alt, Control, Meta or Shift joined by +`,
    });
  }
  const modifiers = parsed.modifiers.reduce(
    (bits, name) => bits | (MODIFIER_BITS.get(name) ?? 0),
    0,
  );
  const key = parsed.modifiers.includes('Shift') ? shifted(base) : base;
  // Control, Meta and Alt make a shortcut, not a character: no text, so nothing is typed.
  const typing = parsed.modifiers.every((name) => name === 'Shift');
  const text = typing ? typedText(key) : undefined;
  const common = {
    key,
    code: keyCodeName(base),
    windowsVirtualKeyCode: code,
    ...(modifiers === 0 ? {} : { modifiers }),
  };
  return {
    down: {
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      ...common,
      ...(text === undefined ? {} : { text }),
    },
    up: { type: 'keyUp', ...common },
  };
}
