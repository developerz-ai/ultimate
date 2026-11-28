// Typed mirror of the SCSS token source, for consumers that cannot read CSS:
// charts, <canvas>, OG-image rendering, transactional email.
//
// `src/tokens/*.scss` is CANONICAL. This file is a hand-maintained mirror and
// `tokens.test.ts` (run by `x verify`) fails if the two ever disagree.

import { unknownTokenError } from '../errors';
import {
  type AliasRole,
  COLOR_ALIASES,
  COLOR_ROLES,
  type ColorRole,
  colorTokens,
  isAliasRole,
  THEME_ROLES,
  type Theme,
  type ThemeRole,
} from './color-tokens';

export type { AliasRole, ChartRole, ColorRole, Theme, ThemeRole } from './color-tokens';
export {
  ALIAS_ROLES,
  CHART_ROLES,
  COLOR_ALIASES,
  COLOR_ROLES,
  colorTokens,
  isAliasRole,
  THEME_ROLES,
  withAliases,
} from './color-tokens';

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

export type RadiusName = keyof typeof radiusTokens;

export const strokeTokens = {
  hairline: '1px',
  thick: '2px',
  heavy: '3px',
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

export type DurationName = keyof typeof durationTokens;
export type EasingName = keyof typeof easingTokens;

/**
 * The spring rungs: physics, plus the `linear()` curve and settle time `springLinear()` (in
 * `src/motion/spring-linear.ts`) answers for it, COMMITTED so a CSS spring costs no JavaScript.
 * `spring-linear.test.ts` regenerates each and fails on drift, here and in `_motion.scss`'s
 * `$spring`. Emitted as `--easing-<name>`, so `t.easing(snappy)` is the spring.
 */
export const springs = {
  gentle: {
    stiffness: 120,
    damping: 20,
    mass: 1,
    duration: 579,
    easing:
      'linear(0, 0.0147, 0.0527, 0.1065, 0.17, 0.2388, 0.3094, 0.3794, 0.4469, 0.5109, 0.5705, 0.6253, 0.6751, 0.7199, 0.7599, 0.7953, 0.8265, 0.8537, 0.8773, 0.8977, 0.9152, 0.9302, 0.9429, 0.9535, 0.9625, 0.97, 0.9762, 0.9814, 0.9856, 0.989, 0.9918, 0.994, 0.9957, 0.9971, 0.9982, 1)',
  },
  snappy: {
    stiffness: 300,
    damping: 30,
    mass: 1,
    duration: 506,
    easing:
      'linear(0, 0.0339, 0.1154, 0.2208, 0.3344, 0.4458, 0.5488, 0.6403, 0.7189, 0.7847, 0.8386, 0.8817, 0.9156, 0.9417, 0.9613, 0.9757, 0.9861, 0.9934, 0.9982, 1.0013, 1.0031, 1.004, 1.0043, 1.0042, 1.0039, 1.0035, 1.003, 1.0025, 1.0021, 1.0016, 1.0013, 1)',
  },
  bouncy: {
    stiffness: 200,
    damping: 12,
    mass: 1,
    duration: 1087,
    easing:
      'linear(0, 0.0253, 0.0938, 0.1945, 0.3166, 0.4502, 0.5869, 0.7193, 0.8417, 0.9499, 1.0411, 1.114, 1.1682, 1.2045, 1.2242, 1.2294, 1.2225, 1.2058, 1.1821, 1.1537, 1.1229, 1.0915, 1.0614, 1.0336, 1.0091, 0.9886, 0.9723, 0.9603, 0.9524, 0.9483, 0.9474, 0.9493, 0.9533, 0.9589, 0.9655, 0.9726, 0.9797, 0.9866, 0.9929, 0.9984, 1.0031, 1.0067, 1.0093, 1.0111, 1.0119, 1.0121, 1.0116, 1.0106, 1.0093, 1.0078, 1.0061, 1.0045, 1.0029, 1.0015, 1.0002, 0.9992, 0.9984, 0.9978, 0.9974, 0.9973, 0.9972, 0.9974, 0.9976, 0.9979, 0.9983, 0.9986, 1)',
  },
} as const;

export type SpringName = keyof typeof springs;

/**
 * The elevation rungs, then the two accent-drawn families: `glow-*` (a halo, no offset — a focused
 * or live edge) and `tinted-*` (a lift whose shadow carries the accent hue — coloured elevation).
 */
export const SHADOW_NAMES = [
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  'glow-sm',
  'glow-md',
  'glow-lg',
  'tinted-sm',
  'tinted-md',
  'tinted-lg',
] as const;

export type ShadowName = (typeof SHADOW_NAMES)[number];

export const shadowTokens: Readonly<Record<Theme, Readonly<Record<ShadowName, string>>>> = {
  light: {
    xs: '0 1px 2px rgb(17 15 13 / 0.06)',
    sm: '0 2px 6px rgb(17 15 13 / 0.08)',
    md: '0 4px 14px rgb(17 15 13 / 0.1)',
    lg: '0 12px 32px rgb(17 15 13 / 0.14)',
    xl: '0 24px 56px rgb(17 15 13 / 0.18)',
    'glow-sm': '0 0 6px rgb(var(--color-accent) / 0.28)',
    'glow-md': '0 0 14px rgb(var(--color-accent) / 0.26)',
    'glow-lg': '0 0 28px rgb(var(--color-accent) / 0.24)',
    'tinted-sm': '0 2px 8px rgb(var(--color-accent) / 0.14)',
    'tinted-md': '0 6px 18px rgb(var(--color-accent) / 0.16)',
    'tinted-lg': '0 14px 36px rgb(var(--color-accent) / 0.18)',
  },
  dark: {
    xs: '0 1px 2px rgb(0 0 0 / 0.4)',
    sm: '0 2px 8px rgb(0 0 0 / 0.48)',
    md: '0 6px 20px rgb(0 0 0 / 0.56)',
    lg: '0 16px 40px rgb(0 0 0 / 0.64)',
    xl: '0 28px 64px rgb(0 0 0 / 0.72)',
    'glow-sm': '0 0 6px rgb(var(--color-accent) / 0.45)',
    'glow-md': '0 0 14px rgb(var(--color-accent) / 0.4)',
    'glow-lg': '0 0 28px rgb(var(--color-accent) / 0.35)',
    'tinted-sm': '0 2px 8px rgb(var(--color-accent) / 0.24)',
    'tinted-md': '0 6px 18px rgb(var(--color-accent) / 0.28)',
    'tinted-lg': '0 14px 36px rgb(var(--color-accent) / 0.32)',
  },
} as const;

/** WCAG 2.5.5's 44 CSS px, as rem so a reader's larger text grows the target with it. */
export const touchTokens = {
  target: '2.75rem',
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

/**
 * `var(--color-accent)` — the channel list, for use inside `rgb()`. An alias role falls back to its
 * source, `var(--color-link, var(--color-accent))`, exactly as `role()` in `_colors.scss` compiles.
 */
export function colorVar(role: ColorRole | AliasRole): string {
  assertThemeRole(role);
  if (isAliasRole(role)) return `var(--color-${role}, var(--color-${COLOR_ALIASES[role]}))`;
  return `var(--color-${role})`;
}

/** `rgb(var(--color-accent) / 0.5)` — a CSS-ready colour. */
export function color(role: ColorRole | AliasRole, alpha = 1): string {
  return `rgb(${colorVar(role)} / ${alpha})`;
}

/**
 * Resolved `rgb(...)` for a theme, with no custom-property indirection — the
 * only form <canvas>, chart libraries, and email clients can consume. An alias answers its
 * source's shipped channels: what renders until a brand sets it.
 */
export function colorRgb(theme: Theme, role: ColorRole | AliasRole, alpha = 1): string {
  assertThemeRole(role);
  const channels = colorTokens[theme][isAliasRole(role) ? COLOR_ALIASES[role] : role];
  return alpha === 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

export function assertColorRole(role: string): asserts role is ColorRole {
  if (!(COLOR_ROLES as readonly string[]).includes(role)) {
    throw unknownTokenError('color', role, COLOR_ROLES);
  }
}

function assertThemeRole(role: string): asserts role is ThemeRole {
  if (!(THEME_ROLES as readonly string[]).includes(role)) {
    throw unknownTokenError('color', role, THEME_ROLES);
  }
}
