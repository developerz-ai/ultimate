// Single responsibility: the one adapter between `@ultimat3/seo`'s tag vocabulary and this
// package's `HeadRenderers` seam. `head.ts` stays injection-only so it is testable without a
// catalog; every caller that renders a real document — `x dev`, `x build`, the server entry —
// binds the seam here instead of writing a fourth private converter.

import type { RenderMetaOptions, RouteMeta, HeadTag as SeoHeadTag } from '@ultimat3/seo';
import { renderMeta } from '@ultimat3/seo';
import type { HeadRenderers, HeadTag } from './head';

/** Attributes that identify a tag for dedupe, read in this order. */
const IDENTITY: Readonly<Record<SeoHeadTag['tag'], readonly string[]>> = {
  title: [],
  meta: ['name', 'property', 'http-equiv', 'charset', 'media'],
  link: ['rel', 'hreflang', 'sizes'],
  script: ['type'],
};

/**
 * `<meta name="description">` → `meta:description`. Scripts also carry their position: a page
 * with three JSON-LD nodes emits three tags with identical attributes, and keying them alike
 * would collapse the graph down to its last node.
 */
export function headTagKey(tag: SeoHeadTag, index: number): string {
  const identity = IDENTITY[tag.tag]
    .map((name) => tag.attrs[name])
    .filter((value): value is string => value !== undefined);
  return [tag.tag, ...identity, ...(tag.tag === 'script' ? [String(index)] : [])].join(':');
}

export function toHeadTag(tag: SeoHeadTag, index: number): HeadTag {
  return {
    kind: tag.tag,
    key: headTagKey(tag, index),
    attrs: tag.attrs,
    ...(tag.text === undefined ? {} : { content: tag.text }),
  };
}

/**
 * `HeadRenderers` backed by `@ultimat3/seo`. There is no `renderLd` half on purpose:
 * `renderMeta` already emits `meta.ld` as JSON-LD scripts, and a second source for the same
 * tags is exactly how a document ends up with two copies of its graph.
 */
export function seoRenderers(options: RenderMetaOptions = {}): HeadRenderers {
  return { renderMeta: (meta: RouteMeta) => renderMeta(meta, options).map(toHeadTag) };
}
