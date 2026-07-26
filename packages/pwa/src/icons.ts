/**
 * Icons and splash screens from ONE source image. Nobody hand-maintains fourteen PNGs;
 * they maintain three and forget the maskable safe zone, which is why installed Android
 * icons end up with clipped logos.
 */

import { NotImplementedError, PwaIconMissingError } from './errors';
import type { ManifestIcon } from './manifest';

export type IconPurpose = 'any' | 'maskable' | 'monochrome' | 'apple-touch';

export interface IconSpec {
  readonly size: number;
  readonly purpose: IconPurpose;
  readonly filename: string;
  /** Fraction of the edge reserved as padding so the safe zone survives masking. */
  readonly padding: number;
}

/** Maskable icons are cropped to a circle of ~80% of the edge; 10% padding per side. */
export const MASKABLE_PADDING = 0.1;

export const ICON_MATRIX: readonly IconSpec[] = Object.freeze([
  { size: 48, purpose: 'any', filename: 'icon-48.png', padding: 0 },
  { size: 72, purpose: 'any', filename: 'icon-72.png', padding: 0 },
  { size: 96, purpose: 'any', filename: 'icon-96.png', padding: 0 },
  { size: 128, purpose: 'any', filename: 'icon-128.png', padding: 0 },
  { size: 192, purpose: 'any', filename: 'icon-192.png', padding: 0 },
  { size: 256, purpose: 'any', filename: 'icon-256.png', padding: 0 },
  { size: 384, purpose: 'any', filename: 'icon-384.png', padding: 0 },
  { size: 512, purpose: 'any', filename: 'icon-512.png', padding: 0 },
  { size: 192, purpose: 'maskable', filename: 'icon-maskable-192.png', padding: MASKABLE_PADDING },
  { size: 512, purpose: 'maskable', filename: 'icon-maskable-512.png', padding: MASKABLE_PADDING },
  { size: 512, purpose: 'monochrome', filename: 'icon-mono-512.png', padding: MASKABLE_PADDING },
  { size: 180, purpose: 'apple-touch', filename: 'apple-touch-icon.png', padding: 0 },
  { size: 167, purpose: 'apple-touch', filename: 'apple-touch-icon-167.png', padding: 0 },
  { size: 152, purpose: 'apple-touch', filename: 'apple-touch-icon-152.png', padding: 0 },
]);

export interface SplashSpec {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly filename: string;
}

/** iOS still needs explicit splash images; every other platform derives them. */
export const SPLASH_MATRIX: readonly SplashSpec[] = Object.freeze([
  { width: 1290, height: 2796, ratio: 3, orientation: 'portrait', filename: 'splash-1290.png' },
  { width: 1179, height: 2556, ratio: 3, orientation: 'portrait', filename: 'splash-1179.png' },
  { width: 1170, height: 2532, ratio: 3, orientation: 'portrait', filename: 'splash-1170.png' },
  { width: 1125, height: 2436, ratio: 3, orientation: 'portrait', filename: 'splash-1125.png' },
  { width: 828, height: 1792, ratio: 2, orientation: 'portrait', filename: 'splash-828.png' },
  { width: 1536, height: 2048, ratio: 2, orientation: 'portrait', filename: 'splash-1536.png' },
  { width: 2048, height: 2732, ratio: 2, orientation: 'portrait', filename: 'splash-2048.png' },
]);

export interface SafeZone {
  /** Pixels of padding on each edge. */
  readonly padding: number;
  /** Edge length of the region the artwork may occupy. */
  readonly inner: number;
}

export function maskableSafeZone(size: number, padding = MASKABLE_PADDING): SafeZone {
  const pad = Math.round(size * padding);
  return { padding: pad, inner: size - pad * 2 };
}

export interface ImageTransform {
  readonly size: number;
  readonly padding: number;
  readonly background?: string;
}

/** The transform driver. Bun's native image API is the intended backing. */
export interface ImagePipeline {
  resize(source: Uint8Array, transform: ImageTransform): Promise<Uint8Array>;
}

/**
 * Interface-complete, implementation pending: Bun's image API is the blessed backing and
 * we will not pull in `sharp` (axiom 7 — no native platform dependencies in the build).
 */
export class BunImagePipeline implements ImagePipeline {
  resize(_source: Uint8Array, transform: ImageTransform): Promise<Uint8Array> {
    throw new NotImplementedError(
      `the icon transform driver is not wired yet (requested ${transform.size}px)`,
      'x icons --driver=external to generate icons with your own tool, or pin bun >= 2.0 ' +
        'once Bun.image ships',
    );
  }
}

export interface IconSourceConfig {
  /** Path to the ONE source icon, 1024x1024 or larger, square. */
  readonly sourceIcon?: string;
  readonly outDir?: string;
  readonly background?: string;
}

export interface IconPlanEntry {
  readonly spec: IconSpec;
  readonly outputPath: string;
  readonly transform: ImageTransform;
  readonly manifestIcon: ManifestIcon | null;
}

export interface IconPlan {
  readonly source: string;
  readonly entries: readonly IconPlanEntry[];
  readonly splashes: readonly SplashSpec[];
  readonly manifestIcons: readonly ManifestIcon[];
}

/** `x doctor` calls this: a missing source icon must report a fix, not a stack trace. */
export function requireSourceIcon(config: IconSourceConfig): string {
  const source = config.sourceIcon;
  if (source === undefined || source.trim() === '') {
    throw new PwaIconMissingError(
      'no source icon: pwa.sourceIcon is unset, so no manifest icon can be generated and ' +
        'the app is not installable',
      "add a 1024x1024 square PNG at assets/icon.png and set pwa.sourceIcon: 'assets/icon.png'",
    );
  }
  return source;
}

export function planIcons(config: IconSourceConfig): IconPlan {
  const source = requireSourceIcon(config);
  const outDir = (config.outDir ?? '/icons').replace(/\/$/, '');

  const entries = ICON_MATRIX.map((spec) => {
    const outputPath = `${outDir}/${spec.filename}`;
    const transform: ImageTransform = {
      size: spec.size,
      padding: spec.padding,
      ...(config.background === undefined ? {} : { background: config.background }),
    };
    return {
      spec,
      outputPath,
      transform,
      manifestIcon: toManifestIcon(spec, outputPath),
    };
  });

  return {
    source,
    entries,
    splashes: SPLASH_MATRIX,
    manifestIcons: entries
      .map((entry) => entry.manifestIcon)
      .filter((icon): icon is ManifestIcon => icon !== null),
  };
}

/** Apple touch icons are `<link rel="apple-touch-icon">`, not manifest members. */
function toManifestIcon(spec: IconSpec, outputPath: string): ManifestIcon | null {
  if (spec.purpose === 'apple-touch') return null;
  return {
    src: outputPath,
    sizes: `${spec.size}x${spec.size}`,
    type: 'image/png',
    purpose: spec.purpose,
  };
}

export function appleTouchLinks(plan: IconPlan): string {
  return plan.entries
    .filter((entry) => entry.spec.purpose === 'apple-touch')
    .map(
      (entry) =>
        `<link rel="apple-touch-icon" sizes="${entry.spec.size}x${entry.spec.size}" href="${entry.outputPath}">`,
    )
    .join('');
}
