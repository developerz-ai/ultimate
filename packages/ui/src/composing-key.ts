// Whether a key press belongs to an IME composition rather than to the control it was typed in:
// the one answer for every field that owns Enter or the arrows.

/** The slice of a `KeyboardEvent` the answer reads — a test builds one as a literal. */
export interface ComposingKey {
  readonly key: string;
  readonly isComposing?: boolean;
  /** Legacy, and still the only signal some engines give: 229 is "the IME took this key". */
  readonly keyCode?: number;
}

/**
 * True while an IME is mid-word. Chrome and Safari on macOS report the Enter that CONFIRMS a
 * candidate as `key: 'Enter'` with `isComposing`; Firefox reports `Process`; Safari fires the
 * confirming keydown after `compositionend` with only `keyCode === 229` left to say so.
 */
export function isComposingKey(event: ComposingKey): boolean {
  return event.isComposing === true || event.key === 'Process' || event.keyCode === 229;
}
