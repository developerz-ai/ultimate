// Colour-vision simulation and perceptual distance over channel tokens, so "the chart series are
// colour-blind safe" is a measured claim (`colour-vision.test.ts`) and an app can measure its own
// series before it ships them. Machado, Oliveira & Fernandes (2009) at full severity, applied in
// linear sRGB; distance is CIE76 ΔE in CIELAB (D65).

/**
 * A simulated dichromat can land a hair outside sRGB; the display clips it. Its own helper, away
 * from the transfer curve, because the clip is a gamut fact, not part of the curve.
 */
const inGamut = (linear: number): number => Math.min(1, Math.max(0, linear));

import { linearize, parseChannels } from './contrast';

/** The three dichromacies. `typical` is the identity, so one loop covers every reader. */
export const COLOUR_VISIONS = ['protan', 'deutan', 'tritan'] as const;
export type ColourVision = (typeof COLOUR_VISIONS)[number] | 'typical';

/**
 * The floor two series must stay apart by, in ΔE76, under every vision. ~2.3 is a just-noticeable
 * difference for two large flat patches; a chart compares thin lines and small slices with a gap
 * between them, so the floor is set well above it. Measured headroom (`As of 2026-10`): the
 * shipped light palette's closest pair is 10.7, its dark one 20.1.
 */
export const CHART_DISTINCT_MIN = 10;

type Matrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

const MACHADO: Readonly<Record<(typeof COLOUR_VISIONS)[number], Matrix>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** Linear light back to an sRGB channel — the inverse of contrast.ts's `linearize`. */
const toChannel = (linear: number): number => {
  const v = inGamut(linear);
  const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
};

/** `"R G B"` as a reader with `vision` sees it, in the same channel spelling. */
export function simulateColourVision(channels: string, vision: ColourVision): string {
  if (vision === 'typical') return channels;
  const [r, g, b] = parseChannels(channels).map(linearize) as [number, number, number];
  return MACHADO[vision].map((row) => toChannel(row[0] * r + row[1] * g + row[2] * b)).join(' ');
}

const labF = (t: number): number =>
  t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t) / 116 + 16 / 116;

function lab(channels: string): readonly [number, number, number] {
  const [r, g, b] = parseChannels(channels).map(linearize) as [number, number, number];
  const x = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE between two channel strings. 0 is identical; black to white is 100. */
export function colourDistance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export interface ClosestPair {
  /** Indexes into the palette, `a < b`. */
  readonly a: number;
  readonly b: number;
  readonly vision: ColourVision;
  readonly distance: number;
}

/**
 * The two series hardest to tell apart, and for whom. One answer rather than a matrix: a palette
 * is as safe as its closest pair, and the pair is what an author has to move.
 */
export function closestChartPair(palette: readonly string[]): ClosestPair {
  let closest: ClosestPair = { a: 0, b: 0, vision: 'typical', distance: Number.POSITIVE_INFINITY };
  for (const vision of ['typical', ...COLOUR_VISIONS] as const) {
    const seen = palette.map((channels) => simulateColourVision(channels, vision));
    for (let a = 0; a < seen.length; a += 1) {
      for (let b = a + 1; b < seen.length; b += 1) {
        const distance = colourDistance(seen[a] as string, seen[b] as string);
        if (distance < closest.distance) closest = { a, b, vision, distance };
      }
    }
  }
  return closest;
}
