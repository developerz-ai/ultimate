// Single responsibility: a route pattern plus `prerender()` params, as the segments a static build
// writes. `prerender()` returns APP data, and each value becomes a directory on disk: a raw `..`
// wrote outside the build output, and a missing param wrote a directory literally named `:slug`.

import { renderCauseValue } from '@ultimat3/core';
import { PrerenderFailedError } from './errors';
import type { RouteParams } from './route';

/** Anything a single path segment may not carry: separators, `?` and `#` (controls: `hasControl`). */
const UNSAFE = /[/\\?#]/;

/** NUL and every C0 control, plus DEL — by code point, so no control character sits in a regex. */
const hasControl = (text: string): boolean => {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const refuse = (pattern: string, param: string, value: unknown, why: string): never => {
  throw new PrerenderFailedError(
    `prerender() gave ${pattern} the ${param} ${renderCauseValue(value)}, which ${why}`,
    `return a value for every param of ${pattern} from prerender(), each one plain path text — slugify it (lowercase, [a-z0-9-]) where it comes from a title or a user`,
  );
};

const checked = (pattern: string, param: string, segment: string): string => {
  if (segment === '.' || segment === '..') {
    return refuse(pattern, param, segment, 'is a dot segment — it would write outside its route');
  }
  if (UNSAFE.test(segment) || hasControl(segment)) {
    return refuse(pattern, param, segment, 'carries a separator, a control character, ? or #');
  }
  return segment;
};

/**
 * The raw (decoded) segments, validated. `:name` must be present and one segment; `*name` may span
 * several (`a/b`) and may be absent, but none of its parts may be a dot segment or unsafe.
 */
export function filledSegments(pattern: string, params: RouteParams): readonly string[] {
  const out: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment === '') continue;
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      const value = Object.hasOwn(params, name) ? params[name] : undefined;
      if (value === undefined || value === '') {
        return refuse(
          pattern,
          name,
          value,
          'is missing — the file would be named after the pattern',
        );
      }
      out.push(checked(pattern, name, value));
      continue;
    }
    if (segment.startsWith('*')) {
      const name = segment.slice(1);
      const value = Object.hasOwn(params, name) ? (params[name] ?? '') : '';
      for (const part of value.split('/')) if (part !== '') out.push(checked(pattern, name, part));
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** The URL form: each segment percent-encoded, as a browser's `pathname` spells it. */
export const urlPathOf = (segments: readonly string[]): string =>
  segments.length === 0 ? '/' : `/${segments.map(encodeURIComponent).join('/')}`;

/** The file form: the DECODED segments, which is what a static server maps a URL back onto. */
export const filePathOf = (segments: readonly string[], indexFile: string): string =>
  [...segments, indexFile].join('/');
