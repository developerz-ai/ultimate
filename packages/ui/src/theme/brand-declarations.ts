// The validators behind `defineTheme()`: each slot's override checked against its canonical list
// and value grammar, then rendered as custom-property lines in that list's order — never the
// caller's — so a brand rendered twice is byte-identical and its CSP hash does not churn.

import { invalidBrandTokenError, unknownTokenError } from '../errors';
import { parseChannels } from '../tokens/contrast';
import {
  COLOR_ROLES,
  type ColorRole,
  type RadiusName,
  radiusTokens,
  SHADOW_NAMES,
  type ShadowName,
} from '../tokens/tokens';
import { FONT_SLOTS, type FontSlot } from './preset-shape';
import { isShadowValue, SHADOW_EXPECTED } from './shadow-value';

/** `0` or a number with a CSS length unit. No `calc()`, no `var()` — a scale rung is a value. */
const LENGTH_PATTERN = /^(0|\d+(\.\d+)?(px|rem|em|ch|%))$/;

/** Family names, quotes and separators only: everything a `font-family` list legitimately needs. */
const FONT_STACK_PATTERN = /^[\w\s,'"-]{1,200}$/;

const LENGTH_EXPECTED = 'a bare CSS length such as "0.5rem", "4px" or "0"';
const STACK_EXPECTED = 'a font-family list such as "Inter, system-ui, sans-serif"';
const CHANNELS_EXPECTED = 'space-separated RGB channels such as "31 110 178"';

function assertKnown(
  kind: string,
  overrides: object,
  known: readonly string[],
  source?: string,
): void {
  for (const name of Object.keys(overrides)) {
    if (!known.includes(name)) throw unknownTokenError(kind, name, known, source);
  }
}

export function colorDeclarations(
  overrides: Partial<Record<ColorRole, string>> | undefined,
  scope: string,
): string[] {
  if (overrides === undefined) return [];
  assertKnown('color', overrides, COLOR_ROLES);
  const out: string[] = [];
  for (const role of COLOR_ROLES) {
    const value = overrides[role];
    if (value === undefined) continue;
    try {
      parseChannels(value);
    } catch {
      throw invalidBrandTokenError(scope, role, value, CHANNELS_EXPECTED);
    }
    out.push(`--color-${role}: ${value};`);
  }
  return out;
}

export function shadowDeclarations(
  overrides: Partial<Record<ShadowName, string>> | undefined,
  scope: string,
): string[] {
  if (overrides === undefined) return [];
  assertKnown('shadow', overrides, SHADOW_NAMES, '_shadow.scss');
  const out: string[] = [];
  for (const name of SHADOW_NAMES) {
    const value = overrides[name];
    if (value === undefined) continue;
    if (!isShadowValue(value)) throw invalidBrandTokenError(scope, name, value, SHADOW_EXPECTED);
    out.push(`--shadow-${name}: ${value};`);
  }
  return out;
}

export function radiusDeclarations(
  overrides: Partial<Record<RadiusName, string>> | undefined,
): string[] {
  if (overrides === undefined) return [];
  const known = Object.keys(radiusTokens) as RadiusName[];
  assertKnown('radius', overrides, known, '_radius.scss');
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

export function fontDeclarations(
  overrides: Partial<Record<FontSlot, string>> | undefined,
): string[] {
  if (overrides === undefined) return [];
  assertKnown('font', overrides, FONT_SLOTS, '_typography.scss');
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
