// A key chord — `'Meta+K'`, `'Shift+Tab'`, `'Escape'` — parsed once and turned into the
// `Input.dispatchKeyEvent` frames a real keyboard would send. Parsed BEFORE any key goes down: a
// refusal halfway through would leave a modifier held for every later verb on the page.
import { ShotKeyInvalidError } from './cdp-shot-errors';

/** The four modifiers, in the browser's own names. */
type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** CDP's bit for each modifier. A `Map`, so a chord word like `constructor` is simply absent. */
const MODIFIER_BITS: ReadonlyMap<string, number> = new Map([
  ['Alt', 1],
  ['Control', 2],
  ['Meta', 4],
  ['Shift', 8],
]);

const isModifier = (word: string): word is Modifier => MODIFIER_BITS.has(word);

const bitOf = (modifier: Modifier): number => MODIFIER_BITS.get(modifier) ?? 0;

/** The modifiers that make a key a SHORTCUT rather than a character. */
const SHORTCUT_BITS = bitOf('Alt') | bitOf('Control') | bitOf('Meta');

/** The named keys a shot presses: code, Windows virtual key code, and the text it types if any. */
const NAMED_KEYS: ReadonlyMap<string, { code: string; keyCode: number; text?: string }> = new Map([
  ['Enter', { code: 'Enter', keyCode: 13, text: '\r' }],
  ['Tab', { code: 'Tab', keyCode: 9 }],
  ['Escape', { code: 'Escape', keyCode: 27 }],
  ['Backspace', { code: 'Backspace', keyCode: 8 }],
  ['Delete', { code: 'Delete', keyCode: 46 }],
  ['Insert', { code: 'Insert', keyCode: 45 }],
  ['Home', { code: 'Home', keyCode: 36 }],
  ['End', { code: 'End', keyCode: 35 }],
  ['PageUp', { code: 'PageUp', keyCode: 33 }],
  ['PageDown', { code: 'PageDown', keyCode: 34 }],
  ['ArrowUp', { code: 'ArrowUp', keyCode: 38 }],
  ['ArrowDown', { code: 'ArrowDown', keyCode: 40 }],
  ['ArrowLeft', { code: 'ArrowLeft', keyCode: 37 }],
  ['ArrowRight', { code: 'ArrowRight', keyCode: 39 }],
  ['Space', { code: 'Space', keyCode: 32, text: ' ' }],
  ['Alt', { code: 'AltLeft', keyCode: 18 }],
  ['Control', { code: 'ControlLeft', keyCode: 17 }],
  ['Meta', { code: 'MetaLeft', keyCode: 91 }],
  ['Shift', { code: 'ShiftLeft', keyCode: 16 }],
  ...Array.from({ length: 12 }, (_, i): [string, { code: string; keyCode: number }] => [
    `F${String(i + 1)}`,
    { code: `F${String(i + 1)}`, keyCode: 112 + i },
  ]),
]);

/** One key, as the dispatch frames need it. `key` is what `KeyboardEvent.key` will read. */
export interface KeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string | undefined;
}

/** A printable character, or a named key; `undefined` for a name the browser does not have. */
export function keyDefinition(key: string): KeyDefinition | undefined {
  const named = NAMED_KEYS.get(key);
  if (named !== undefined) return { key: key === 'Space' ? ' ' : key, ...named };
  if ([...key].length !== 1) return undefined;
  if (key === ' ') return { key, code: 'Space', keyCode: 32, text: ' ' };
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper))
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key))
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  return { key, code: '', keyCode: 0, text: key };
}

export interface KeyChord {
  /** In the order written, which is the order they go down; they come up in reverse. */
  readonly modifiers: readonly Modifier[];
  readonly key: KeyDefinition;
}

/** Refuses an empty chord, a trailing `+`, an unknown modifier or key, and a modifier held twice. */
export function parseKeyChord(chord: string): KeyChord {
  if (chord === '') throw new ShotKeyInvalidError({ chord, reason: 'is empty' });
  const parts = chord.split('+');
  const last = parts.at(-1) ?? '';
  if (last === '') {
    throw new ShotKeyInvalidError({ chord, reason: "ends in '+', so it names no key to press" });
  }
  const modifiers: Modifier[] = [];
  for (const word of parts.slice(0, -1)) {
    if (!isModifier(word)) {
      throw new ShotKeyInvalidError({
        chord,
        reason: `names ${JSON.stringify(word)} as a modifier, and the browser holds only Meta, Control, Alt, Shift`,
      });
    }
    if (modifiers.includes(word)) {
      throw new ShotKeyInvalidError({ chord, reason: `holds ${word} twice` });
    }
    modifiers.push(word);
  }
  const key = keyDefinition(last);
  if (key === undefined) {
    throw new ShotKeyInvalidError({
      chord,
      reason: `names ${JSON.stringify(last)}, which is neither one character nor a key the browser names`,
    });
  }
  return { modifiers, key };
}

/** One `Input.dispatchKeyEvent` payload. */
export type KeyFrame = Readonly<Record<string, unknown>>;

const frame = (type: string, key: KeyDefinition, bits: number, text?: string): KeyFrame => ({
  type,
  key: key.key,
  code: key.code,
  windowsVirtualKeyCode: key.keyCode,
  modifiers: bits,
  ...(text === undefined ? {} : { text, unmodifiedText: text }),
});

/**
 * Every frame of one chord, in order: each modifier down, the key down and up, the modifiers up in
 * reverse. A key under Control, Alt or Meta sends NO text — a shortcut types nothing, and a
 * `keyDown` carrying text would put the letter into whatever field holds focus.
 */
export function chordFrames(chord: KeyChord): readonly KeyFrame[] {
  const frames: KeyFrame[] = [];
  let bits = 0;
  for (const modifier of chord.modifiers) {
    bits |= bitOf(modifier);
    const held = keyDefinition(modifier);
    if (held !== undefined) frames.push(frame('rawKeyDown', held, bits));
  }
  const shortcut = (bits & SHORTCUT_BITS) !== 0;
  const text = shortcut ? undefined : chord.key.text;
  frames.push(frame(text === undefined ? 'rawKeyDown' : 'keyDown', chord.key, bits, text));
  frames.push(frame('keyUp', chord.key, bits));
  for (const modifier of [...chord.modifiers].reverse()) {
    const held = keyDefinition(modifier);
    bits &= ~bitOf(modifier);
    if (held !== undefined) frames.push(frame('keyUp', held, bits));
  }
  return frames;
}

/** The frames that type one character into whatever holds focus. */
export function characterFrames(character: string): readonly KeyFrame[] {
  const key = keyDefinition(character) ?? { key: character, code: '', keyCode: 0, text: character };
  const text = key.text ?? character;
  return [frame('keyDown', key, 0, text), frame('keyUp', key, 0)];
}
