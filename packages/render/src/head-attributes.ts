// Single responsibility: the attributes of one `<head>` tag. `attributePair` is the rule, with one
// exception for what a `link` href may name, and a dropped attribute is said out loud in dev: an
// icon or an alternate that prints with no href otherwise fails with nothing to read.

import { escapeHtml, isLocal, logger, safeUrl } from '@ultimat3/core';
import type { HeadTag } from './head';
import { attributePair } from './html';

/** A declared app deep link. Spelled exactly: a control character in it is not this scheme. */
const APP_LINK = /^(?:android-app|ios-app):\/\//i;

/** Past this many a row is spreading new keys every render: stop remembering, stop warning. */
const MAX_WARNED_DROPS = 256;
const warnedDrops = new Set<string>();

/**
 * A `link` href is fetched or read as metadata, never navigated, so `safeUrl` answers it as it does
 * a rendered `src`: a raster `data:image/` stays (an inline favicon), SVG and every other scheme do
 * not. `rel="alternate"` alone is never fetched at all, only read by a crawler, so the two app-link
 * schemes are kept there, on the exact value: `alternate stylesheet` is a fetch.
 */
function linkHref(tag: HeadTag, value: string): string | null {
  const url = safeUrl(value, 'src');
  if (url !== null) return url;
  const rel = tag.attrs?.['rel'];
  const isAlternate = typeof rel === 'string' && rel.trim().toLowerCase() === 'alternate';
  return isAlternate && APP_LINK.test(value) ? value : null;
}

function pairOf(tag: HeadTag, name: string, value: string | boolean): string | null {
  if (tag.kind !== 'link' || name.toLowerCase() !== 'href' || typeof value !== 'string') {
    return attributePair(name, value);
  }
  const url = linkHref(tag, value);
  return url === null ? null : `${name}="${escapeHtml(url)}"`;
}

/** Names the tag and the attribute, never the value: it is a row's, and this is a log line. */
function warnDropped(tag: HeadTag, name: string): void {
  if (!isLocal({ fallback: 'production' })) return;
  const seen = `${tag.key}\n${name}`;
  if (warnedDrops.has(seen) || warnedDrops.size >= MAX_WARNED_DROPS) return;
  warnedDrops.add(seen);
  logger.warn('head.attribute_dropped', { tag: tag.key, attribute: name });
}

/** The attribute string of `tag`, leading space included, or `''`. */
export function headAttributes(tag: HeadTag): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(tag.attrs ?? {})) {
    const pair = pairOf(tag, name, value);
    if (pair !== null) parts.push(pair);
    // `false` is how a tag says "not this one", so nothing was lost.
    else if (value !== false) warnDropped(tag, name);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}
