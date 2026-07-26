// The shared vocabulary every component's props draw from. One size scale, one
// tone scale — a component that needs a new rung adds it here, not locally.

export const SIZES = ['sm', 'md', 'lg'] as const;
export type Size = (typeof SIZES)[number];

/** Maps 1:1 onto the status colour roles in `_colors.scss`. */
export const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;
export type Tone = (typeof TONES)[number];

export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'link'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export type Align = 'start' | 'center' | 'end' | 'stretch' | 'between';

/** Space token step, as used by the layout primitives. */
export type SpaceStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;
