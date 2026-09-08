// Which fields the user has LEFT (touched) and which they have CHANGED (dirty). Pure, and
// deliberately not a value store: this binding is server-authoritative, so it holds opinions about
// the user's progress through the form and never a second copy of what the form says.

/** Two sets, addressed in the same path grammar a control's `name` and a schema issue use. */
export interface FormTouch {
  readonly touched: ReadonlySet<string>;
  readonly dirty: ReadonlySet<string>;
}

const NO_PATHS: ReadonlySet<string> = new Set();

export const NO_FORM_TOUCH: FormTouch = Object.freeze({ touched: NO_PATHS, dirty: NO_PATHS });

/**
 * An empty control and an absent baseline are the same thing to the person filling the form: they
 * typed something into a new record's field and then deleted it again, and calling that "changed"
 * turns every abandoned keystroke into an unsaved-changes prompt. `Object.is` for everything else,
 * so `0` and `false` are values and not blanks.
 */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return isBlank(a) && isBlank(b);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** The user left the control. Touched is one-way: leaving a field cannot un-visit it. */
export function markTouched(touch: FormTouch, path: string): FormTouch {
  if (touch.touched.has(path)) return touch;
  return { touched: new Set([...touch.touched, path]), dirty: touch.dirty };
}

/**
 * The user changed the control. `changed` is two-way on purpose — typing a character and deleting
 * it again leaves the form clean, which is the only answer an "unsaved changes" guard can act on.
 */
export function markDirty(touch: FormTouch, path: string, changed: boolean): FormTouch {
  if (touch.dirty.has(path) === changed) return touch;
  const dirty = new Set(touch.dirty);
  if (changed) dirty.add(path);
  else dirty.delete(path);
  return { touched: touch.touched, dirty };
}

/** Anything at all to lose. What a navigation guard asks. */
export function isFormDirty(touch: FormTouch): boolean {
  return touch.dirty.size > 0;
}
