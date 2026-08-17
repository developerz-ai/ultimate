/**
 * `<head>` management. Merges `@ultimat3/seo`'s output with per-route overrides, deduped
 * by key so the last writer wins deterministically, and owns the one inlined script the
 * framework allows on a 0kb `site/` route: the theme flip.
 *
 * The seo renderers are injected rather than imported so render stays testable without a
 * catalog and so the tag vocabulary keeps exactly one owner (`@ultimat3/seo`).
 */

import type { RouteMeta } from '@ultimat3/seo';
import { BudgetExceededError } from './errors';
// `html.ts` is this package's one escaper — a second one is how a character ends up missing.
import { escapeAttribute, escapeJsonContent, escapeRawTextContent, escapeText } from './html';

export type HeadTagKind = 'title' | 'base' | 'meta' | 'link' | 'script' | 'style';

export interface HeadTag {
  readonly kind: HeadTagKind;
  /** Dedupe key. `title`, `meta:description`, `link:canonical`, `script:theme`. */
  readonly key: string;
  readonly attrs?: Readonly<Record<string, string | boolean>>;
  /** Text content for `title`, `script`, `style`. */
  readonly content?: string;
}

export type MetaRenderer = (meta: RouteMeta) => readonly HeadTag[];
export type LdRenderer = (meta: RouteMeta) => string | null;

export interface HeadRenderers {
  /** `@ultimat3/seo`'s `renderMeta`, adapted to `HeadTag[]`. */
  readonly renderMeta: MetaRenderer;
  /** `@ultimat3/seo`'s `renderLd`, returning the JSON-LD body or null. */
  readonly renderLd?: LdRenderer;
}

const KIND_ORDER: readonly HeadTagKind[] = ['base', 'title', 'meta', 'link', 'style', 'script'];

/**
 * Later sources win per key. Order is by kind, then by first-seen position within the
 * kind — stable output matters because the shell's bytes are content-hashed.
 */
export function mergeHead(...sources: readonly (readonly HeadTag[])[]): readonly HeadTag[] {
  const byKey = new Map<string, HeadTag>();
  const order: string[] = [];
  for (const source of sources) {
    for (const tag of source) {
      if (!byKey.has(tag.key)) order.push(tag.key);
      byKey.set(tag.key, tag);
    }
  }
  const merged = order
    .map((key) => byKey.get(key))
    .filter((tag): tag is HeadTag => tag !== undefined);
  return merged.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** Build the head for a route from its `meta` output plus explicit overrides. */
/**
 * The tags every HTML document needs and no route should have to declare. Merged FIRST, so a
 * route that sets one of these keys still wins.
 *
 * Absent until now, and the omission was not cosmetic: with no `viewport`, a phone lays the page
 * out at ~980px and scales it down, so every deployed Ultimate app rendered zoomed-out on mobile
 * whatever its CSS said. `color-scheme` is the other half of the token layer's dark mode — without
 * it the browser paints its own form controls and scrollbars light under a dark page.
 */
export const documentBaseline = (): readonly HeadTag[] => [
  { kind: 'meta', key: 'meta:charset', attrs: { charset: 'utf-8' } },
  {
    kind: 'meta',
    key: 'meta:viewport',
    attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' },
  },
  {
    kind: 'meta',
    key: 'meta:color-scheme',
    attrs: { name: 'color-scheme', content: 'light dark' },
  },
];

export function headFromMeta(
  meta: RouteMeta,
  renderers: HeadRenderers,
  overrides: readonly HeadTag[] = [],
): readonly HeadTag[] {
  const seoTags = [...documentBaseline(), ...renderers.renderMeta(meta)];
  const ld = renderers.renderLd?.(meta) ?? null;
  const ldTags: readonly HeadTag[] =
    ld === null
      ? []
      : [
          {
            kind: 'script',
            key: 'script:ld+json',
            attrs: { type: 'application/ld+json' },
            content: ld,
          },
        ];
  return mergeHead(seoTags, ldTags, overrides);
}

const VOID_KINDS = new Set<HeadTagKind>(['meta', 'link', 'base']);

export function renderHead(tags: readonly HeadTag[]): string {
  return tags.map(renderTag).join('');
}

function renderTag(tag: HeadTag): string {
  const attrs = Object.entries(tag.attrs ?? {})
    .map(([name, value]) =>
      value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(value))}"`,
    )
    .join('');
  if (VOID_KINDS.has(tag.kind)) return `<${tag.kind}${attrs}>`;
  const raw = tag.content ?? '';
  return `<${tag.kind}${attrs}>${contentOf(tag, raw)}</${tag.kind}>`;
}

/**
 * Three contexts, three rules, and the one that was missing was the one attacker text reaches.
 * `script`/`style` are raw text (`escapeRawTextContent`); a JSON-carrying script is data, so it
 * takes the total JSON rule; everything else is HTML text, where a character reference IS decoded.
 * `content` was emitted VERBATIM for script and style until `As of 2026-08`, which made any string
 * reaching `meta.ld` — a title, a product name, a bio — able to close the element.
 */
function contentOf(tag: HeadTag, raw: string): string {
  if (tag.kind !== 'script' && tag.kind !== 'style') return escapeText(raw);
  return carriesJson(tag) ? escapeJsonContent(raw) : escapeRawTextContent(raw);
}

/** `application/ld+json`, `application/json`, any `…+json`: the body is data, not code. */
function carriesJson(tag: HeadTag): boolean {
  const type = tag.attrs?.['type'];
  return typeof type === 'string' && type.trim().toLowerCase().endsWith('json');
}

export interface ThemeScriptOptions {
  /** Attribute the tokens key off. Never a class, never a raw colour. */
  readonly attribute?: string;
  readonly storageKey?: string;
  /** Hard cap; a theme script that grows past this is no longer "one inlined script". */
  readonly maxBytes?: number;
}

export const THEME_SCRIPT_MAX_BYTES = 512;

/**
 * The injection point for the no-flash theme flip. It sets a semantic attribute and
 * nothing else — every colour is a token, so the whole scheme swap is one attribute.
 * Returns a `HeadTag` so it participates in dedupe like any other tag.
 */
export function themeScript(options: ThemeScriptOptions = {}): HeadTag {
  const attribute = options.attribute ?? 'data-theme';
  const storageKey = options.storageKey ?? 'x-theme';
  const source =
    `try{var t=localStorage.getItem("${storageKey}")||` +
    `(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");` +
    `document.documentElement.setAttribute("${attribute}",t)}catch(e){}`;

  const bytes = new TextEncoder().encode(source).byteLength;
  const cap = options.maxBytes ?? THEME_SCRIPT_MAX_BYTES;
  if (bytes > cap) {
    throw new BudgetExceededError(
      `the inlined theme script is ${bytes}b, over its ${cap}b cap — the only script a ` +
        '0kb site/ route is allowed to ship',
      'shrink the theme script, or raise maxBytes deliberately in the head config',
    );
  }

  return { kind: 'script', key: 'script:theme', content: source };
}
