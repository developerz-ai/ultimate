// Typed mirror of the SCSS token source, for consumers that cannot read CSS:
// charts, <canvas>, OG-image rendering, transactional email.
//
// `src/tokens/*.scss` is CANONICAL. This file is a hand-maintained mirror and
// `tokens.test.ts` (run by `x verify`) fails if the two ever disagree.

import { unknownTokenError } from '../errors';

export type Theme = 'light' | 'dark';

export const COLOR_ROLES = [
  'bg',
  'bg-soft',
  'surface',
  'surface-raised',
  'fg',
  'fg-strong',
  'fg-muted',
  'line',
  'scrim',
  'accent',
  'accent-strong',
  'accent-fg',
  'success',
  'success-soft',
  'success-fg',
  'warning',
  'warning-soft',
  'warning-fg',
  'danger',
  'danger-soft',
  'danger-fg',
  'info',
  'info-soft',
  'info-fg',
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];

/** Space-separated RGB channels, mirroring `_colors.scss`. */
export const colorTokens: Readonly<Record<Theme, Readonly<Record<ColorRole, string>>>> = {
  light: {
    bg: '253 246 240',
    'bg-soft': '245 237 230',
    surface: '250 245 241',
    'surface-raised': '255 255 255',
    fg: '38 34 31',
    'fg-strong': '17 15 13',
    'fg-muted': '110 102 94',
    line: '224 216 208',
    scrim: '17 15 13',
    accent: '34 122 197',
    'accent-strong': '21 92 152',
    'accent-fg': '255 255 255',
    success: '22 128 84',
    'success-soft': '222 244 232',
    'success-fg': '255 255 255',
    warning: '176 106 8',
    'warning-soft': '253 240 213',
    'warning-fg': '255 255 255',
    danger: '190 42 42',
    'danger-soft': '253 227 227',
    'danger-fg': '255 255 255',
    info: '34 122 197',
    'info-soft': '224 239 252',
    'info-fg': '255 255 255',
  },
  dark: {
    bg: '18 18 20',
    'bg-soft': '28 28 32',
    surface: '34 34 39',
    'surface-raised': '44 44 50',
    fg: '228 226 222',
    'fg-strong': '248 247 245',
    'fg-muted': '150 146 140',
    line: '54 54 60',
    scrim: '0 0 0',
    accent: '96 170 240',
    'accent-strong': '130 190 248',
    'accent-fg': '16 20 26',
    success: '74 190 130',
    'success-soft': '22 46 34',
    'success-fg': '12 26 18',
    warning: '226 170 66',
    'warning-soft': '52 42 20',
    'warning-fg': '28 20 6',
    danger: '240 110 110',
    'danger-soft': '56 26 26',
    'danger-fg': '30 12 12',
    info: '96 170 240',
    'info-soft': '22 38 56',
    'info-fg': '12 20 30',
  },
} as const;

export const spaceTokens = {
  '0': '0',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
} as const;

export const radiusTokens = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  pill: '999px',
  full: '50%',
} as const;

export const zTokens = {
  base: '0',
  raised: '10',
  sticky: '100',
  dropdown: '200',
  drawer: '300',
  dialog: '400',
  popover: '500',
  tooltip: '600',
  toast: '700',
  'skip-nav': '800',
} as const;

export const durationTokens = {
  instant: '0ms',
  fast: '120ms',
  base: '220ms',
  slow: '400ms',
  slower: '640ms',
} as const;

export const easingTokens = {
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  in: 'cubic-bezier(0.5, 0, 0.75, 0)',
  'in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

export const shadowTokens: Readonly<Record<Theme, Readonly<Record<string, string>>>> = {
  light: {
    xs: '0 1px 2px rgb(17 15 13 / 0.06)',
    sm: '0 2px 6px rgb(17 15 13 / 0.08)',
    md: '0 4px 14px rgb(17 15 13 / 0.1)',
    lg: '0 12px 32px rgb(17 15 13 / 0.14)',
    xl: '0 24px 56px rgb(17 15 13 / 0.18)',
  },
  dark: {
    xs: '0 1px 2px rgb(0 0 0 / 0.4)',
    sm: '0 2px 8px rgb(0 0 0 / 0.48)',
    md: '0 6px 20px rgb(0 0 0 / 0.56)',
    lg: '0 16px 40px rgb(0 0 0 / 0.64)',
    xl: '0 28px 64px rgb(0 0 0 / 0.72)',
  },
} as const;

export const breakpointTokens = {
  sm: '480px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export const fontSizeTokens = {
  xs: 'clamp(0.75rem, 0.73rem + 0.1vw, 0.8125rem)',
  sm: 'clamp(0.875rem, 0.85rem + 0.15vw, 0.9375rem)',
  md: 'clamp(1rem, 0.96rem + 0.2vw, 1.0625rem)',
  lg: 'clamp(1.125rem, 1.05rem + 0.35vw, 1.25rem)',
  xl: 'clamp(1.375rem, 1.2rem + 0.7vw, 1.75rem)',
  '2xl': 'clamp(1.75rem, 1.4rem + 1.4vw, 2.5rem)',
  '3xl': 'clamp(2.25rem, 1.6rem + 2.6vw, 3.5rem)',
} as const;

export const fontWeightTokens = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeightTokens = {
  tight: '1.2',
  snug: '1.35',
  normal: '1.55',
  loose: '1.75',
} as const;

/** `var(--color-accent)` — the channel list, for use inside `rgb()`. */
export function colorVar(role: ColorRole): string {
  assertColorRole(role);
  return `var(--color-${role})`;
}

/** `rgb(var(--color-accent) / 0.5)` — a CSS-ready colour. */
export function color(role: ColorRole, alpha = 1): string {
  return `rgb(${colorVar(role)} / ${alpha})`;
}

/**
 * Resolved `rgb(...)` for a theme, with no custom-property indirection — the
 * only form <canvas>, chart libraries, and email clients can consume.
 */
export function colorRgb(theme: Theme, role: ColorRole, alpha = 1): string {
  assertColorRole(role);
  const channels = colorTokens[theme][role];
  return alpha === 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

export function assertColorRole(role: string): asserts role is ColorRole {
  if (!(COLOR_ROLES as readonly string[]).includes(role)) {
    throw unknownTokenError('color', role, COLOR_ROLES);
  }
}
