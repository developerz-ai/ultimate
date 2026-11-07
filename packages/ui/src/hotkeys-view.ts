// What a key press means to a page's shortcut table, apart from any listener: never while typing,
// never with a modifier, a two-key chord inside one window, and `mod+` that fires anywhere. Pure,
// so `useHotkeys` and `ShortcutSheet` read ONE table and the binding and its legend cannot drift.

import { invalidValueError } from './errors';

/** One shortcut: the bindings that run it, its already-translated legend line, and the work. */
export interface HotkeyRow {
  /**
   * Alternatives, each spelled as `KeyboardEvent.key` reports it: `'?'`, `'Escape'`, a chord of
   * two steps `'g r'`, or the platform modifier `'mod+k'` (⌘ on Apple, Ctrl elsewhere).
   */
  readonly keys: readonly string[];
  readonly label: string;
  readonly run: () => void;
}

export type HotkeyTable = readonly HotkeyRow[];

/** How long the second key of a chord may follow the first. */
export const CHORD_WINDOW_MS = 1_000;

/** The parts of a `KeyboardEvent` the rule reads; `editable` is the shell's `closest()` answer. */
export interface HotkeyKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly editable: boolean;
  /** `event.timeStamp` — monotonic, which is all the chord window compares. */
  readonly at: number;
}

export interface HotkeyState {
  /** `mod` is ⌘ on Apple platforms, Ctrl everywhere else. */
  readonly mac: boolean;
  /** The first step of a chord in flight, or `null`. */
  readonly pending: string | null;
  readonly since: number;
}

export const IDLE_HOTKEY_STATE: HotkeyState = { mac: false, pending: null, since: 0 };

/** A validated table: every binding to its row, and every chord's first step. */
export interface CompiledHotkeys {
  readonly bindings: ReadonlyMap<string, HotkeyRow>;
  readonly prefixes: ReadonlySet<string>;
}

const MOD = 'mod+';
const KEY = /^(?:\S|[A-Z][A-Za-z0-9]+)$/;

/** The steps of one binding, or `null` when it is not in the grammar. */
function stepsOf(binding: string): readonly string[] | null {
  const steps = binding.split(' ');
  if (steps.length > 2) return null;
  for (const step of steps) {
    const key = step.startsWith(MOD) && steps.length === 1 ? step.slice(MOD.length) : step;
    if (!KEY.test(key)) return null;
  }
  return steps;
}

/**
 * Validate and index rows — one table or every island's merged. A binding twice, a chord over two
 * keys, a chord whose first step is also a binding of its own, or `mod+` inside a chord is
 * `X_UI_INVALID_VALUE` naming the keys: each is a shortcut that can never fire as written.
 */
export function compileHotkeys(rows: HotkeyTable): CompiledHotkeys {
  const bindings = new Map<string, HotkeyRow>();
  const prefixes = new Set<string>();
  const expected =
    "unique bindings of one key ('?'), 'mod+<key>', or a two-key chord ('g r'), none a prefix of another";
  for (const row of rows) {
    if (row.keys.length === 0)
      throw invalidValueError('useHotkeys', `${row.label}: no keys`, expected);
    for (const binding of row.keys) {
      const steps = stepsOf(binding);
      if (steps === null) throw invalidValueError('useHotkeys', binding, expected);
      if (bindings.has(binding)) throw invalidValueError('useHotkeys', binding, expected);
      const first = steps[0] ?? '';
      if (steps.length === 2) {
        if (bindings.has(first)) throw invalidValueError('useHotkeys', first, expected);
        prefixes.add(first);
      } else if (prefixes.has(binding)) {
        throw invalidValueError('useHotkeys', binding, expected);
      }
      bindings.set(binding, row);
    }
  }
  return { bindings, prefixes };
}

export interface HotkeyAnswer {
  /** The row to run, if the key completed one. The shell calls `preventDefault` then `run`. */
  readonly row: HotkeyRow | undefined;
  readonly state: HotkeyState;
}

const idle = (state: HotkeyState): HotkeyState =>
  state.pending === null ? state : { ...state, pending: null };

/** What one key press does, given the chord in flight and the table. */
export function hotkeyAction(
  event: HotkeyKeyEvent,
  state: HotkeyState,
  table: CompiledHotkeys,
): HotkeyAnswer {
  // An IME is mid-word: every key belongs to the composition, not the page.
  if (event.isComposing || event.key === 'Process') return { row: undefined, state };
  const mod = state.mac ? event.metaKey : event.ctrlKey;
  const otherMod = state.mac ? event.ctrlKey : event.metaKey;
  if (mod && !otherMod && !event.altKey) {
    return { row: table.bindings.get(`${MOD}${event.key}`), state: idle(state) };
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return { row: undefined, state: idle(state) };
  if (event.editable && event.key !== 'Escape') return { row: undefined, state: idle(state) };

  if (state.pending !== null && event.at - state.since <= CHORD_WINDOW_MS) {
    const chord = table.bindings.get(`${state.pending} ${event.key}`);
    if (chord !== undefined) return { row: chord, state: idle(state) };
  }
  const single = table.bindings.get(event.key);
  if (single !== undefined) return { row: single, state: idle(state) };
  if (table.prefixes.has(event.key)) {
    return { row: undefined, state: { ...state, pending: event.key, since: event.at } };
  }
  return { row: undefined, state: idle(state) };
}

const NAMED = new Map<string, string>([
  ['Escape', 'Esc'],
  ['ArrowUp', '↑'],
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
]);

/**
 * A binding as keycaps, one group per chord step: `mod+k` → `[['⌘', 'K']]` on Apple and
 * `[['Ctrl', 'K']]` elsewhere — the glyphs printed on the keys, so they are not translated.
 */
export function hotkeyKeycaps(binding: string, mac: boolean): readonly (readonly string[])[] {
  return binding.split(' ').map((step) => {
    if (!step.startsWith(MOD)) return [NAMED.get(step) ?? step];
    const key = step.slice(MOD.length);
    return [mac ? '⌘' : 'Ctrl', key.length === 1 ? key.toUpperCase() : (NAMED.get(key) ?? key)];
  });
}
