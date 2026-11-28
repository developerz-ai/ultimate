// Where `x design research` writes, named once: `x shot --against` and `ui.research` read the same
// directory and the same file names, and a second spelling of either is a reference nobody finds.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ShotViewport } from './shot-viewport';

/** Under `.x/`, which every scaffold ignores: third-party pixels are never committed. */
export const DESIGN_DIR = join('.x', 'design');

export const DESIGN_SCHEMES = ['light', 'dark'] as const;
export type DesignScheme = (typeof DESIGN_SCHEMES)[number];

/** A phone and a desktop: the two widths a reference is photographed at unless `--viewport` says. */
export const DESIGN_VIEWPORTS: readonly ShotViewport[] = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

export const REFERENCE_FILE = 'reference.json';
export const TOKENS_FILE = 'tokens.proposal.json';
export const MOTION_MAP_FILE = 'motion-map.json';
export const SOURCES_FILE = 'sources.json';

/** `shot-390-light.png`: keyed by width and scheme, the pair `x shot --against` matches on. */
export const referenceShotName = (width: number, scheme: DesignScheme): string =>
  `shot-${String(width)}-${scheme}.png`;

export const REFERENCE_SHOT_PATTERN = /^shot-(\d+)-(light|dark)\.png$/;

/**
 * One directory per reference URL: host and path, lower-case, every other run of characters a
 * dash, at most 80 — readable in a listing and safe on every filesystem. The query is dropped: a
 * catalogue's `?tab=` is the same page to a designer, and a slug carrying it is a path an agent
 * cannot guess.
 */
export function designSlug(url: string): string {
  const parsed = new URL(url);
  const raw = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug === '' ? 'reference' : slug;
}
