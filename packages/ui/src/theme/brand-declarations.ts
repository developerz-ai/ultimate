// The validators behind `defineTheme()`: each slot's override checked against its canonical list
// and value grammar, then rendered as custom-property lines in that list's order — never the
// caller's — so a brand rendered twice is byte-identical and its CSP hash does not churn.

import { isJsonObject } from '@ultimat3/core';
import { invalidBrandTokenError, unknownTokenError } from '../errors';
import { parseChannels } from '../tokens/contrast';
import {
  type DurationName,
  durationTokens,
  type EasingName,
  easingTokens,
  type RadiusName,
  radiusTokens,
  SHADOW_NAMES,
  type ShadowName,
  THEME_ROLES,
  type ThemeRole,
} from '../tokens/tokens';
import { FONT_SLOTS, type FontSlot } from './preset-shape';
import { isShadowValue, SHADOW_EXPECTED } from './shadow-value';

/** `0` or a number with a CSS length unit. No `calc()`, no `var()` — a scale rung is a value. */
const LENGTH_PATTERN = /^(0|\d+(\.\d+)?(px|rem|em|ch|%))$/;

/**
 * Family names, quotes and separators only: everything a `font-family` list legitimately needs.
 * The separator is a literal SPACE, never `\s`: the HTML parser rewrites a CR or CRLF inside a
 * `<style>` to LF before the browser hashes it, so a stack carrying one served bytes whose sha256
 * no longer matched the CSP hash computed here, and the brand's whole stylesheet was blocked.
 */
const FONT_STACK_PATTERN = /^[\w ,'"-]{1,200}$/;

/** A non-negative time with its unit — `t.duration()` hands it to `transition` as written. */
const TIME_PATTERN = /^(0|\d+(\.\d+)?(ms|s))$/;
const NUMBER = '-?\\d+(?:\\.\\d+)?';
/** Four numbers and nothing else: no keyword, no `steps()`, no `var()` — a curve is a value. */
const CURVE_PATTERN = new RegExp(
  `^cubic-bezier\\((${NUMBER}), (${NUMBER}), (${NUMBER}), (${NUMBER})\\)$`,
);

const TIME_EXPECTED = 'a CSS time such as "180ms", "0.3s" or "0"';
const CURVE_EXPECTED =
  'a curve such as "cubic-bezier(0.2, 0, 0, 1)", its two x values between 0 and 1';
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
  overrides: Partial<Record<ThemeRole, string>> | undefined,
  scope: string,
): string[] {
  if (overrides === undefined) return [];
  assertKnown('color', overrides, THEME_ROLES);
  const out: string[] = [];
  for (const role of THEME_ROLES) {
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

/** The motion slot: the two scales `_motion.scss` emits, each overridden rung by rung. */
export interface MotionInput {
  duration?: Partial<Record<DurationName, string>> | undefined;
  easing?: Partial<Record<EasingName, string>> | undefined;
}

const MOTION_SCALES = ['duration', 'easing'] as const;

/** A curve CSS keeps: x1 and x2 are points in time, and outside [0, 1] the declaration is dropped. */
function isCurve(value: string): boolean {
  const match = CURVE_PATTERN.exec(value);
  if (match === null) return false;
  return [match[1], match[3]].every((x) => Number(x) >= 0 && Number(x) <= 1);
}

const SCALE_EXPECTED = 'an object of rungs such as { base: "180ms" }';

export function motionDeclarations(overrides: MotionInput | undefined): string[] {
  if (overrides === undefined) return [];
  // Checked as `unknown`, so the typed slot below keeps its scale keys: a theme read from JSON can
  // carry `null` or an array where the type says an object.
  const slot: unknown = overrides;
  if (!isJsonObject(slot)) {
    throw invalidBrandTokenError('theme', 'motion', slot, 'an object with duration or easing');
  }
  assertKnown('motion', overrides, MOTION_SCALES, '_motion.scss');
  for (const scale of MOTION_SCALES) {
    const rungs: unknown = overrides[scale];
    if (rungs !== undefined && !isJsonObject(rungs)) {
      throw invalidBrandTokenError('motion', scale, rungs, SCALE_EXPECTED);
    }
  }
  const out: string[] = [];
  const durations = overrides.duration ?? {};
  const durationNames = Object.keys(durationTokens) as DurationName[];
  assertKnown('duration', durations, durationNames, '_motion.scss');
  for (const name of durationNames) {
    const value = durations[name];
    if (value === undefined) continue;
    if (!TIME_PATTERN.test(value)) {
      throw invalidBrandTokenError('motion.duration', name, value, TIME_EXPECTED);
    }
    // A unitless `0` is a length, not a <time>: `transition-duration: var(--duration-x)` would be
    // invalid at computed time, so the zero carries its unit.
    out.push(`--duration-${name}: ${value === '0' ? '0ms' : value};`);
  }
  const easings = overrides.easing ?? {};
  const easingNames = Object.keys(easingTokens) as EasingName[];
  assertKnown('easing', easings, easingNames, '_motion.scss');
  for (const name of easingNames) {
    const value = easings[name];
    if (value === undefined) continue;
    if (!isCurve(value)) throw invalidBrandTokenError('motion.easing', name, value, CURVE_EXPECTED);
    out.push(`--easing-${name}: ${value};`);
  }
  return out;
}
