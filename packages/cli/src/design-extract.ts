// What one reference capture measured, parsed out of the page's answer to `DESIGN_PASS`
// (`design-extract-script.ts`) and re-sanitised here. The page is untrusted: it can overwrite the
// recorder, so every value is schema-parsed, every number clamped, and every string that is not a
// CSS keyword, a bounded identifier or an http(s) URL is dropped — page text never reaches a file.

import { t } from '@ultimat3/schema';
import type { ShotPage } from './browser-launcher-port';
import { DESIGN_PASS } from './design-extract-script';

export type ColorUse = 'background' | 'text' | 'border';
export type MotionTrigger = 'enter' | 'hover' | 'scroll' | 'loop' | 'state';

export interface ObservedColor {
  readonly rgb: readonly [number, number, number];
  readonly alpha: number;
  readonly use: ColorUse;
  /** Painted area for a background, characters for text, elements for a border. */
  readonly weight: number;
}

export interface ObservedFont {
  readonly family: string;
  readonly sizePx: number;
  readonly weight: number;
  readonly uses: number;
}

export interface ObservedShadow {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly inset: boolean;
  readonly rgb: readonly [number, number, number];
  readonly alpha: number;
  readonly count: number;
}

export interface ObservedMotion {
  readonly kind: 'animation' | 'transition';
  readonly trigger: MotionTrigger;
  readonly durationMs: number;
  readonly delayMs: number;
  /** A CSS easing keyword or function, or `other` when the page answered something else. */
  readonly easing: string;
  /** `-1` is infinite. */
  readonly iterations: number;
  readonly properties: readonly string[];
  /** How many times this exact record was seen across the captures merged into it. */
  readonly count: number;
}

export interface Extraction {
  readonly colors: readonly ObservedColor[];
  readonly fonts: readonly ObservedFont[];
  readonly spacing: readonly { readonly px: number; readonly count: number }[];
  readonly radii: readonly { readonly px: number; readonly count: number }[];
  readonly shadows: readonly ObservedShadow[];
  readonly backdrop: { readonly count: number; readonly blurPx: readonly number[] };
  readonly canvases: number;
  readonly motion: readonly ObservedMotion[];
  readonly links: readonly string[];
}

const RGB = t.array(t.number);
const COUNTED = t.array(t.object({ px: t.number, count: t.number }));
const ANSWER = t.object({
  colors: t.array(t.object({ rgb: RGB, alpha: t.number, use: t.string, weight: t.number })),
  fonts: t.array(
    t.object({ family: t.string, sizePx: t.number, weight: t.number, uses: t.number }),
  ),
  spacing: COUNTED,
  radii: COUNTED,
  shadows: t.array(
    t.object({
      x: t.number,
      y: t.number,
      blur: t.number,
      spread: t.number,
      inset: t.boolean,
      rgb: RGB,
      alpha: t.number,
      count: t.number,
    }),
  ),
  backdrop: t.object({ count: t.number, blurPx: t.array(t.number) }),
  canvases: t.number,
  motion: t.array(
    t.object({
      kind: t.string,
      trigger: t.string,
      durationMs: t.number,
      delayMs: t.number,
      easing: t.string,
      iterations: t.number,
      properties: t.array(t.string),
    }),
  ),
  links: t.array(t.string),
});

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const channel = (value: number | undefined): number => Math.round(clamp(value ?? 0, 0, 255));

const rgbOf = (values: readonly number[]): readonly [number, number, number] => [
  channel(values[0]),
  channel(values[1]),
  channel(values[2]),
];

/** A family name a stylesheet could spell: letters, digits, spaces, dashes, ≤ 3 words. */
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+){0,2}$/;
const PROPERTY = /^-?[a-zA-Z][a-zA-Z-]{0,39}$/;
const EASING =
  /^(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(\s*-?[\d.]+\s*(?:,\s*-?[\d.]+\s*){3}\)|steps\(\s*\d+\s*(?:,\s*[a-z-]+\s*)?\)|linear\([-\d.,%\s]{1,2000}\))$/;
const USES: readonly ColorUse[] = ['background', 'text', 'border'];
const TRIGGERS: readonly MotionTrigger[] = ['enter', 'hover', 'scroll', 'loop', 'state'];

const httpUrl = (text: string): string | undefined => {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** The page's answer, parsed and sanitised. A shape that does not parse throws schema's code. */
export function parseExtraction(value: unknown): Extraction {
  const raw = ANSWER.parse(value, 'design extraction');
  return {
    colors: raw.colors.flatMap((color) => {
      const use = USES.find((known) => known === color.use);
      return use === undefined
        ? []
        : [
            {
              rgb: rgbOf(color.rgb),
              alpha: clamp(color.alpha, 0, 1),
              use,
              weight: clamp(color.weight, 0, 1e9),
            },
          ];
    }),
    fonts: raw.fonts
      .filter((font) => font.family.length <= 40 && FAMILY.test(font.family))
      .map((font) => ({
        family: font.family,
        sizePx: Math.round(clamp(font.sizePx, 1, 400)),
        weight: Math.round(clamp(font.weight, 1, 1000)),
        uses: clamp(font.uses, 0, 1e9),
      })),
    spacing: raw.spacing.map((s) => ({
      px: Math.round(clamp(s.px, 0, 400)),
      count: clamp(s.count, 0, 1e6),
    })),
    radii: raw.radii.map((r) => ({
      px: Math.round(clamp(r.px, 0, 1000)),
      count: clamp(r.count, 0, 1e6),
    })),
    shadows: raw.shadows.map((s) => ({
      x: clamp(s.x, -500, 500),
      y: clamp(s.y, -500, 500),
      blur: clamp(s.blur, 0, 500),
      spread: clamp(s.spread, -500, 500),
      inset: s.inset,
      rgb: rgbOf(s.rgb),
      alpha: clamp(s.alpha, 0, 1),
      count: clamp(s.count, 0, 1e6),
    })),
    backdrop: {
      count: Math.round(clamp(raw.backdrop.count, 0, 1e6)),
      blurPx: raw.backdrop.blurPx.slice(0, 20).map((px) => clamp(px, 0, 500)),
    },
    canvases: Math.round(clamp(raw.canvases, 0, 1e4)),
    motion: raw.motion.slice(0, 600).map((m) => ({
      kind: m.kind === 'transition' ? 'transition' : 'animation',
      trigger: TRIGGERS.find((known) => known === m.trigger) ?? 'state',
      durationMs: clamp(m.durationMs, 0, 60_000),
      delayMs: clamp(m.delayMs, 0, 60_000),
      easing: EASING.test(m.easing.trim()) ? m.easing.trim() : 'other',
      iterations: m.iterations < 0 ? -1 : Math.round(clamp(m.iterations, 0, 1e6)),
      properties: m.properties.filter((p) => PROPERTY.test(p)).slice(0, 12),
      count: 1,
    })),
    links: raw.links.slice(0, 300).flatMap((link) => httpUrl(link) ?? []),
  };
}

/** Run the pass on a page already navigated (with `DESIGN_PREPARE` installed) and parse it. */
export async function extractDesign(page: ShotPage): Promise<Extraction> {
  return parseExtraction(await page.evaluate(DESIGN_PASS));
}

/** Entries equal under `key` folded into one, `add` summing their weight. */
function fold<T>(items: readonly T[], key: (item: T) => string, add: (a: T, b: T) => T): T[] {
  const out = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const held = out.get(k);
    out.set(k, held === undefined ? item : add(held, item));
  }
  return [...out.values()];
}

/** Several captures of one reference (each viewport, one scheme) as one census. */
export function mergeExtractions(list: readonly Extraction[]): Extraction {
  const byWeight = <T extends { readonly weight: number }>(a: T, b: T): T => ({
    ...a,
    weight: a.weight + b.weight,
  });
  const byCount = <T extends { readonly count: number }>(a: T, b: T): T => ({
    ...a,
    count: a.count + b.count,
  });
  return {
    colors: fold(
      list.flatMap((e) => e.colors),
      (c) => `${c.use} ${c.rgb.join(' ')} ${String(c.alpha)}`,
      byWeight,
    ),
    fonts: fold(
      list.flatMap((e) => e.fonts),
      (f) => `${f.family}|${String(f.sizePx)}|${String(f.weight)}`,
      (a, b) => ({ ...a, uses: a.uses + b.uses }),
    ),
    spacing: fold(
      list.flatMap((e) => e.spacing),
      (s) => String(s.px),
      byCount,
    ),
    radii: fold(
      list.flatMap((e) => e.radii),
      (r) => String(r.px),
      byCount,
    ),
    shadows: fold(
      list.flatMap((e) => e.shadows),
      (s) => JSON.stringify({ ...s, count: 0 }),
      byCount,
    ),
    backdrop: {
      count: list.reduce((sum, e) => sum + e.backdrop.count, 0),
      blurPx: list.flatMap((e) => e.backdrop.blurPx).slice(0, 20),
    },
    canvases: Math.max(0, ...list.map((e) => e.canvases)),
    motion: fold(
      list.flatMap((e) => e.motion),
      (m) => JSON.stringify({ ...m, count: 0 }),
      byCount,
    ),
    links: [...new Set(list.flatMap((e) => e.links))],
  };
}
