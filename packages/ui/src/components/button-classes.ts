// The classes a button's look is made of — asked by `<Button>` and by `<Link appearance="button">`,
// so a control that submits and a control that navigates cannot drift into two looks. Keys into
// `Button.module.scss`, never class names: the scoped name is the stylesheet's to give.

import type { ButtonVariant, Size, Tone } from './variants';

export interface ButtonLook {
  variant?: ButtonVariant | undefined;
  tone?: Tone | undefined;
  size?: Size | undefined;
  fullWidth?: boolean | undefined;
}

/** The classes of the element's CONTENT, which both elements wrap their label in. */
export const BUTTON_CONTENT_KEYS = ['label', 'spinner'] as const;

export function buttonClassKeys(look: ButtonLook): readonly string[] {
  return [
    'button',
    `variant-${look.variant ?? 'primary'}`,
    `tone-${look.tone ?? 'accent'}`,
    `size-${look.size ?? 'md'}`,
    ...(look.fullWidth === true ? ['full'] : []),
  ];
}
