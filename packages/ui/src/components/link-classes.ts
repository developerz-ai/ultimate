// Which stylesheet a `<Link>` reads and which of its classes — the one decision `appearance`
// makes. Pure, so it is testable with no renderer: the `.tsx` only maps the answer onto a sheet.

import { type ButtonLook, buttonClassKeys } from './button-classes';
import type { Tone } from './variants';

export interface LinkLook extends Omit<ButtonLook, 'tone'> {
  appearance?: 'link' | 'button' | undefined;
  underline?: 'always' | 'hover' | 'none' | undefined;
  /** A text link's own two tones, or — as a button — any `Tone`. */
  tone?: Tone | 'inherit' | undefined;
}

export interface LinkClasses {
  /** `button` is `Button.module.scss`: one set of button styles, whichever element wears them. */
  readonly sheet: 'link' | 'button';
  readonly keys: readonly string[];
}

export function linkClasses(look: LinkLook): LinkClasses {
  if (look.appearance === 'button') {
    return {
      sheet: 'button',
      // `inherit` is a text link's tone and no button has it; the type refuses the pairing, and a
      // caller that got past the type gets the default tone rather than a class nothing declares.
      keys: buttonClassKeys({
        variant: look.variant,
        tone: look.tone === 'inherit' ? undefined : look.tone,
        size: look.size,
        fullWidth: look.fullWidth,
      }),
    };
  }
  return {
    sheet: 'link',
    keys: ['link', `underline-${look.underline ?? 'hover'}`, `tone-${look.tone ?? 'accent'}`],
  };
}
