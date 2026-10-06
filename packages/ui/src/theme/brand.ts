// The ONE way to restyle the design system without forking it: `defineTheme()` validates a set of
// token overrides and renders the custom properties that beat `theme.scss` at every specificity
// level it emits. There is deliberately no SCSS `@use ... with ()` seam — two ways to change the
// accent colour is the ambiguity axiom 1 exists to delete.

import { insufficientContrastError, invalidBrandTokenError, runtimeMissingError } from '../errors';
import { contrastRatio } from '../tokens/contrast';
import { CONTRAST_PAIRS } from '../tokens/contrast-pairs';
import {
  COLOR_ROLES,
  type ColorRole,
  colorTokens,
  type RadiusName,
  SHADOW_NAMES,
  type ShadowName,
  shadowTokens,
  type Theme,
} from '../tokens/tokens';
import {
  colorDeclarations,
  fontDeclarations,
  radiusDeclarations,
  shadowDeclarations,
} from './brand-declarations';
import type { FontSlot, ThemePreset } from './preset-shape';
import { THEME_PRESET_NAMES, THEME_PRESETS, type ThemePresetName } from './presets';

export type { FontSlot } from './preset-shape';
export { FONT_SLOTS } from './preset-shape';

type Themed<K extends string> = Partial<Record<Theme, Partial<Record<K, string>>>>;

export interface BrandInput {
  /**
   * A shipped palette to start from (`THEME_PRESETS`). Every other slot layers onto it role by
   * role, so `{ preset: 'scifi', colors: { dark: { accent: … } } }` is scifi with your accent.
   */
  preset?: ThemePresetName | undefined;
  /** Channel overrides per theme. Omit a theme to leave it at the shipped palette. */
  colors?: Themed<ColorRole> | undefined;
  /** Shadow overrides per theme, by rung (`SHADOW_NAMES`) — elevation is themed like colour. */
  shadows?: Themed<ShadowName> | undefined;
  radius?: Partial<Record<RadiusName, string>> | undefined;
  font?: Partial<Record<FontSlot, string>> | undefined;
}

export interface Brand {
  /** The stylesheet text. Ship it in a `<style>` after `global.scss`, or write it to a file. */
  readonly css: string;
}

/**
 * Validate and freeze a brand. Every value is checked here rather than at render time, so a bad
 * override fails at the app's entry point with the role that broke it named — not as a silently
 * dropped declaration a human has to spot in devtools.
 */
export function defineTheme(input: BrandInput): Brand {
  const base = presetOf(input.preset);
  const colors = {
    light: layer(base?.colors.light, input.colors?.light),
    dark: layer(base?.colors.dark, input.colors?.dark),
  };
  const shadows = {
    light: layer(base?.shadows?.light, input.shadows?.light),
    dark: layer(base?.shadows?.dark, input.shadows?.dark),
  };
  const light = [
    ...colorDeclarations(colors.light, 'colors.light'),
    ...shadowDeclarations(shadows.light, 'shadows.light'),
  ];
  const dark = [
    ...colorDeclarations(colors.dark, 'colors.dark'),
    ...shadowDeclarations(shadows.dark, 'shadows.dark'),
  ];
  // Measured AFTER the channels parse and BEFORE a single declaration is rendered: a palette that
  // fails AA is not a stylesheet with a warning attached, it is a refusal. The pairings are the
  // ones the framework's own palette is held to (`CONTRAST_PAIRS`), so an app cannot ship a brand
  // the design system would have failed its own tests over. A preset is measured as part of the
  // palette it builds — the merged result is what renders.
  assertContrast('light', colors.light);
  assertContrast('dark', colors.dark);
  const root: string[] = [
    ...light,
    ...radiusDeclarations(layer(base?.radius, input.radius)),
    ...fontDeclarations(layer(base?.font, input.font)),
  ];
  const blocks: string[] = [];
  if (root.length > 0) blocks.push(rule(':root', root));

  // `theme.scss` emits light at `:root`, dark behind the media query, and BOTH again under
  // `html[data-theme]`. A brand that only wrote `:root` would lose to those attribute rules on
  // specificity, so every level it emits is answered here, in the same order.
  if (light.length > 0) blocks.push(rule("html[data-theme='light']", light));
  const media = [
    ...darkMediaDeclarations('color', COLOR_ROLES, colors, colorTokens.dark),
    ...darkMediaDeclarations('shadow', SHADOW_NAMES, shadows, shadowTokens.dark),
  ];
  if (media.length > 0) {
    blocks.push(`@media (prefers-color-scheme: dark) {\n${indent(rule(':root', media))}\n}`);
  }
  if (dark.length > 0) blocks.push(rule("html[data-theme='dark']", dark));

  return Object.freeze({ css: blocks.join('\n\n') });
}

/**
 * The named preset, or `undefined` for none. Own-property lookup: a brand read from a JSON config
 * reaches here untyped, and `'toString'` must be a refusal, not `Object.prototype.toString`.
 */
function presetOf(name: ThemePresetName | undefined): ThemePreset | undefined {
  if (name === undefined) return undefined;
  if (!Object.hasOwn(THEME_PRESETS, name)) {
    const known = THEME_PRESET_NAMES.map((preset) => `"${preset}"`).join(', ');
    throw invalidBrandTokenError('input', 'preset', name, `a preset @ultimat3/ui ships: ${known}`);
  }
  return THEME_PRESETS[name];
}

/**
 * `overrides` on top of `base`, key by key. An `undefined` value is no override — a spread would
 * copy it and erase the preset's value for that key, rendering the shipped default in its place.
 */
function layer<V extends string>(
  base: Readonly<Partial<Record<string, V>>> | undefined,
  overrides: Readonly<Partial<Record<string, V>>> | undefined,
): Record<string, V> | undefined {
  if (base === undefined && overrides === undefined) return undefined;
  const out: Record<string, V> = {};
  for (const source of [base, overrides]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/** The exact tag to inline, after `global.scss` so the overrides land later in the cascade. */
export function brandStyleTag(brand: Brand): string {
  return `<style>${brand.css}</style>`;
}

/**
 * `'sha256-…'` for exactly what `brandStyleTag` puts between the tags — the one `style-src` source
 * that admits it under the framework's locked CSP. Server/build-only, like the theme script's
 * hash: `defineTheme` runs at the app's entry point, and the header is written there too.
 */
export function brandStyleCspSource(brand: Brand): string {
  if (typeof Bun === 'undefined') {
    throw runtimeMissingError(
      'Bun.CryptoHasher to hash the brand stylesheet',
      'call brandStyleCspSource() during build or SSR, never in browser code',
    );
  }
  return `'sha256-${new Bun.CryptoHasher('sha256').update(brand.css).digest('base64')}'`;
}

function rule(selector: string, declarations: readonly string[]): string {
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}`;
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * The dark media `:root` must answer every token the brand's own `:root` touched. That `:root`
 * (light) comes after `theme.scss`'s dark media `:root` at equal specificity, so a role overridden
 * in light only would otherwise reach an OS-dark document with no `data-theme` — scripting off, or
 * storage throwing in the boot script — on the dark palette it was never measured against. Such a
 * token is answered with the SHIPPED dark value. Called after both scopes were validated.
 */
function darkMediaDeclarations<K extends string>(
  prefix: string,
  names: readonly K[],
  scopes: {
    readonly light: Partial<Record<string, string>> | undefined;
    readonly dark: Partial<Record<string, string>> | undefined;
  },
  shippedDark: Readonly<Record<K, string>>,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value =
      scopes.dark?.[name] ?? (scopes.light?.[name] === undefined ? undefined : shippedDark[name]);
    if (value !== undefined) out.push(`--${prefix}-${name}: ${value};`);
  }
  return out;
}

/**
 * The palette as it will actually render: the shipped channels, with this brand's overrides on
 * top. Measured on the RESOLVED set and not on the overrides alone, because the pairing that
 * breaks is nearly always one the author only touched half of — a new `accent` against the
 * shipped `accent-fg` is the single most common way a brand goes unreadable.
 */
function assertContrast(
  theme: Theme,
  overrides: Partial<Record<ColorRole, string>> | undefined,
): void {
  if (overrides === undefined) return;
  const resolved = (role: ColorRole): string => overrides[role] ?? colorTokens[theme][role];
  for (const pair of CONTRAST_PAIRS) {
    // Only pairings this brand can have changed. The rest are the shipped palette, which
    // `contrast.test.ts` already holds — re-reporting them would blame the app for our colours.
    if (overrides[pair.fg] === undefined && overrides[pair.bg] === undefined) continue;
    const fg = resolved(pair.fg);
    const bg = resolved(pair.bg);
    const ratio = contrastRatio(fg, bg);
    if (ratio >= pair.minimum) continue;
    throw insufficientContrastError(theme, pair.what, pair.fg, pair.bg, ratio, pair.minimum);
  }
}
