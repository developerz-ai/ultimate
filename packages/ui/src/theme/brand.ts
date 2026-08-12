// The ONE way to restyle the design system without forking it: `defineTheme()` validates a set of
// token overrides and renders the custom properties that beat `theme.scss` at every specificity
// level it emits. There is deliberately no SCSS `@use ... with ()` seam — two ways to change the
// accent colour is the ambiguity axiom 1 exists to delete.

import { invalidBrandTokenError, runtimeMissingError, unknownTokenError } from '../errors';
import { parseChannels } from '../tokens/contrast';
import {
  COLOR_ROLES,
  type ColorRole,
  type RadiusName,
  radiusTokens,
  type Theme,
} from '../tokens/tokens';

/** The two font slots `_typography.scss` emits. */
export const FONT_SLOTS = ['sans', 'mono'] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

export interface BrandInput {
  /** Channel overrides per theme. Omit a theme to leave it at the shipped palette. */
  colors?: Partial<Record<Theme, Partial<Record<ColorRole, string>>>> | undefined;
  radius?: Partial<Record<RadiusName, string>> | undefined;
  font?: Partial<Record<FontSlot, string>> | undefined;
}

export interface Brand {
  /** The stylesheet text. Ship it in a `<style>` after `global.scss`, or write it to a file. */
  readonly css: string;
}

/** `0` or a number with a CSS length unit. No `calc()`, no `var()` — a scale rung is a value. */
const LENGTH_PATTERN = /^(0|\d+(\.\d+)?(px|rem|em|ch|%))$/;

/** Family names, quotes and separators only: everything a `font-family` list legitimately needs. */
const FONT_STACK_PATTERN = /^[\w\s,'"-]{1,200}$/;

const LENGTH_EXPECTED = 'a bare CSS length such as "0.5rem", "4px" or "0"';
const STACK_EXPECTED = 'a font-family list such as "Inter, system-ui, sans-serif"';
const CHANNELS_EXPECTED = 'space-separated RGB channels such as "31 110 178"';

/**
 * Validate and freeze a brand. Every value is checked here rather than at render time, so a bad
 * override fails at the app's entry point with the role that broke it named — not as a silently
 * dropped declaration a human has to spot in devtools.
 */
export function defineTheme(input: BrandInput): Brand {
  const blocks: string[] = [];
  const light = colorDeclarations(input.colors?.light, 'colors.light');
  const dark = colorDeclarations(input.colors?.dark, 'colors.dark');
  const root: string[] = [
    ...light,
    ...radiusDeclarations(input.radius),
    ...fontDeclarations(input.font),
  ];
  if (root.length > 0) blocks.push(rule(':root', root));

  // `theme.scss` emits light at `:root`, dark behind the media query, and BOTH again under
  // `html[data-theme]`. A brand that only wrote `:root` would lose to those attribute rules on
  // specificity, so every level it emits is answered here, in the same order.
  if (light.length > 0) blocks.push(rule("html[data-theme='light']", light));
  if (dark.length > 0) {
    blocks.push(`@media (prefers-color-scheme: dark) {\n${indent(rule(':root', dark))}\n}`);
    blocks.push(rule("html[data-theme='dark']", dark));
  }

  return Object.freeze({ css: blocks.join('\n\n') });
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
 * Ordered by the canonical role list, not by the caller's object — a brand file rendered twice
 * must be byte-identical, or every consumer's CSP hash and diff churns for nothing.
 */
function colorDeclarations(
  overrides: Partial<Record<ColorRole, string>> | undefined,
  scope: string,
): string[] {
  if (overrides === undefined) return [];
  for (const role of Object.keys(overrides)) {
    if (!(COLOR_ROLES as readonly string[]).includes(role)) {
      throw unknownTokenError('color', role, COLOR_ROLES);
    }
  }
  const out: string[] = [];
  for (const role of COLOR_ROLES) {
    const value = overrides[role];
    if (value === undefined) continue;
    assertChannels(scope, role, value);
    out.push(`--color-${role}: ${value};`);
  }
  return out;
}

function radiusDeclarations(overrides: Partial<Record<RadiusName, string>> | undefined): string[] {
  if (overrides === undefined) return [];
  const known = Object.keys(radiusTokens) as RadiusName[];
  for (const name of Object.keys(overrides)) {
    if (!(known as readonly string[]).includes(name)) {
      throw unknownTokenError('radius', name, known, '_radius.scss');
    }
  }
  const out: string[] = [];
  for (const name of known) {
    const value = overrides[name];
    if (value === undefined) continue;
    if (!LENGTH_PATTERN.test(value)) {
      throw invalidBrandTokenError('radius', name, value, LENGTH_EXPECTED);
    }
    out.push(`--radius-${name}: ${value};`);
  }
  return out;
}

function fontDeclarations(overrides: Partial<Record<FontSlot, string>> | undefined): string[] {
  if (overrides === undefined) return [];
  for (const slot of Object.keys(overrides)) {
    if (!(FONT_SLOTS as readonly string[]).includes(slot)) {
      throw unknownTokenError('font', slot, FONT_SLOTS, '_typography.scss');
    }
  }
  const out: string[] = [];
  for (const slot of FONT_SLOTS) {
    const value = overrides[slot];
    if (value === undefined) continue;
    if (!FONT_STACK_PATTERN.test(value)) {
      throw invalidBrandTokenError('font', slot, value, STACK_EXPECTED);
    }
    out.push(`--font-${slot}: ${value};`);
  }
  return out;
}

function assertChannels(scope: string, role: string, value: string): void {
  try {
    parseChannels(value);
  } catch {
    throw invalidBrandTokenError(scope, role, value, CHANNELS_EXPECTED);
  }
}
