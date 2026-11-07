// A destructive confirmation's rules, apart from its markup: idle → busy → idle or refused, a
// second submit while busy refused, and a confirm label that names the act. Pure, so the island
// path and its test decide the same thing.

import { invalidValueError } from '../errors';

export type ConfirmState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  /** The act was refused: the dialog stays open with `message` in its form summary. */
  | { readonly kind: 'refused'; readonly message: string };

export type ConfirmEvent =
  | { readonly type: 'submit' }
  /** `onConfirm` settled: `undefined` is done, a string is the already-translated refusal. */
  | { readonly type: 'settled'; readonly refusal: string | undefined }
  /** The dialog closed, by Cancel or Esc: the next opening starts clean. */
  | { readonly type: 'closed' };

export const CONFIRM_IDLE: ConfirmState = { kind: 'idle' };

/** The next state, or `null` for an event the current state refuses — a submit while busy. */
export function confirmStep(state: ConfirmState, event: ConfirmEvent): ConfirmState | null {
  switch (event.type) {
    case 'submit':
      return state.kind === 'busy' ? null : { kind: 'busy' };
    case 'settled':
      if (state.kind !== 'busy') return null;
      return event.refusal === undefined
        ? CONFIRM_IDLE
        : { kind: 'refused', message: event.refusal };
    case 'closed':
      return state.kind === 'busy' ? null : CONFIRM_IDLE;
  }
}

/**
 * A confirm button says what it does — "Delete post", never "OK" — so there is no default and an
 * empty one is `X_UI_INVALID_VALUE`: the label is the last thing read before an act that cannot
 * be taken back.
 */
export function confirmLabelOf(label: string): string {
  if (label.trim() === '') {
    throw invalidValueError('ConfirmDialog confirmLabel', label, 'a verb naming the act');
  }
  return label;
}
