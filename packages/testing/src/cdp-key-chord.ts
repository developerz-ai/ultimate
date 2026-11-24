// A key chord as `press()` takes it — `Tab`, `Control+k`, `Meta+Shift+Enter` — split into the key
// and CDP's `modifiers` bitmask (`Input.dispatchKeyEvent`: Alt 1, Control 2, Meta 4, Shift 8).

const MODIFIERS: ReadonlyMap<string, number> = new Map([
  ['Alt', 1],
  ['Control', 2],
  ['Meta', 4],
  ['Shift', 8],
]);

export const SHIFT = 8;

export interface KeyChord {
  readonly key: string;
  /** `0` when no modifier is held. */
  readonly modifiers: number;
}

/**
 * `undefined` for a chord naming an unknown modifier or no key. A lone `+` is the key itself, and
 * so is the last `+` of `Control++`.
 */
export function parseKeyChord(chord: string): KeyChord | undefined {
  if (chord === '+' || !chord.includes('+')) return { key: chord, modifiers: 0 };
  const plusKey = chord.endsWith('++');
  const parts = (plusKey ? chord.slice(0, -2) : chord).split('+');
  const key = plusKey ? '+' : parts.pop();
  if (key === undefined || key === '') return undefined;
  let modifiers = 0;
  for (const name of parts) {
    const bit = MODIFIERS.get(name);
    if (bit === undefined) return undefined;
    modifiers |= bit;
  }
  return { key, modifiers };
}

/** The modifier names `press()` knows, for its refusal. */
export const MODIFIER_NAMES: readonly string[] = [...MODIFIERS.keys()];
