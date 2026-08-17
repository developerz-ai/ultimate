// The typed metadata model and its rendering to head tags. Nothing here reaches
// for a global default: a route that does not declare a description does not get
// one, it fails the build (see validate.ts).

import { absoluteUrl, attributes, escapeXml } from './xml';

/** Search results truncate past this; validate.ts enforces it. */
export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MIN_LENGTH = 50;
export const DESCRIPTION_MAX_LENGTH = 160;

export interface RobotsDirectives {
  index?: boolean;
  follow?: boolean;
  maxSnippet?: number;
  maxImagePreview?: 'none' | 'standard' | 'large';
  maxVideoPreview?: number;
  noarchive?: boolean;
}

export interface OpenGraphImage {
  url: string;
  /** 1200x630 is the card size every platform crops from. */
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
}

export interface OpenGraph {
  type?: 'website' | 'article' | 'profile' | 'product' | 'video.other';
  title?: string;
  description?: string;
  url?: string;
  siteName?: string;
  locale?: string;
  image?: string | OpenGraphImage;
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
  section?: string;
  tags?: readonly string[];
}

export interface TwitterCard {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player';
  site?: string;
  creator?: string;
  image?: string;
  imageAlt?: string;
}

export interface AlternateLocale {
  /** BCP-47 tag, or `x-default`. */
  hreflang: string;
  href: string;
}

export interface ThemeColor {
  /** Any CSS colour. Pull it from @ultimat3/ui's tokens at the call site. */
  color: string;
  scheme?: 'light' | 'dark';
}

export interface RouteMeta {
  title?: string;
  /** `'%s — Ultimate'`. Applied unless the title already contains the brand. */
  titleTemplate?: string;
  description?: string;
  canonical?: string;
  robots?: RobotsDirectives;
  og?: OpenGraph;
  twitter?: TwitterCard;
  /** One entry per locale. `x-default` is added automatically when absent. */
  alternates?: readonly AlternateLocale[];
  /** The href `x-default` points at. Defaults to the canonical. */
  xDefault?: string;
  themeColor?: readonly ThemeColor[];
  /** JSON-LD nodes from `ld.*`. Rendered as one script tag per node. */
  ld?: readonly Readonly<Record<string, unknown>>[];
}

export interface HeadTag {
  readonly tag: 'title' | 'meta' | 'link' | 'script';
  readonly attrs: Readonly<Record<string, string>>;
  /** Text content, already safe to embed for `title`; escaped on render. */
  readonly text?: string;
}

export interface RenderMetaOptions {
  /** Absolutises canonical, og:url, and alternates. */
  baseUrl?: string;
  /** Resolved path, used when `canonical` is omitted. */
  path?: string;
}

/**
 * Separators a title template puts between the slot and the brand. Stripped so the BRAND is what
 * the containment test reads: `'%s — Ultimate'` means the brand is `Ultimate`, not `— Ultimate`.
 */
const TEMPLATE_SEPARATORS = /^[\s\-–—|·:>/]+|[\s\-–—|·:>/]+$/g;

/**
 * The containment was `template.includes(title)` — inverted, so it only ever answered true when
 * the title EQUALLED the brand. `applyTitleTemplate('About Ultimate', '%s — Ultimate')` produced
 * `'About Ultimate — Ultimate'`, which `validate.ts` then measured against `TITLE_MAX_LENGTH`.
 */
export function applyTitleTemplate(title: string, template?: string): string {
  if (template === undefined || template === '') return title;
  const brand = template.replace('%s', '').replace(TEMPLATE_SEPARATORS, '');
  if (brand !== '' && title.includes(brand)) return title;
  return template.replace('%s', title);
}

export function robotsContent(directives: RobotsDirectives): string {
  const parts: string[] = [
    directives.index === false ? 'noindex' : 'index',
    directives.follow === false ? 'nofollow' : 'follow',
  ];
  if (directives.noarchive === true) parts.push('noarchive');
  if (directives.maxSnippet !== undefined) parts.push(`max-snippet:${directives.maxSnippet}`);
  if (directives.maxImagePreview !== undefined) {
    parts.push(`max-image-preview:${directives.maxImagePreview}`);
  }
  if (directives.maxVideoPreview !== undefined) {
    parts.push(`max-video-preview:${directives.maxVideoPreview}`);
  }
  return parts.join(',');
}

/**
 * Full alternate set including `x-default`, which tells search engines which
 * URL to serve when no declared locale matches the user. Omitting it is the most
 * common i18n SEO bug, so it is added rather than merely allowed.
 */
export function hreflangSet(
  alternates: readonly AlternateLocale[],
  fallbackHref: string | undefined,
): readonly AlternateLocale[] {
  if (alternates.length === 0) return [];
  const hasDefault = alternates.some((entry) => entry.hreflang === 'x-default');
  if (hasDefault) return alternates;
  const href = fallbackHref ?? alternates[0]?.href;
  return href === undefined ? alternates : [...alternates, { hreflang: 'x-default', href }];
}

export function renderMeta(meta: RouteMeta, options: RenderMetaOptions = {}): readonly HeadTag[] {
  const tags: HeadTag[] = [];
  const abs = (value: string): string =>
    options.baseUrl === undefined ? value : absoluteUrl(options.baseUrl, value);

  const canonical = meta.canonical ?? (options.path === undefined ? undefined : options.path);
  const canonicalHref = canonical === undefined ? undefined : abs(canonical);

  if (meta.title !== undefined) {
    tags.push({
      tag: 'title',
      attrs: {},
      text: applyTitleTemplate(meta.title, meta.titleTemplate),
    });
  }
  if (meta.description !== undefined) {
    tags.push({ tag: 'meta', attrs: { name: 'description', content: meta.description } });
  }
  if (canonicalHref !== undefined) {
    tags.push({ tag: 'link', attrs: { rel: 'canonical', href: canonicalHref } });
  }
  tags.push({
    tag: 'meta',
    attrs: { name: 'robots', content: robotsContent(meta.robots ?? {}) },
  });

  // --- Open Graph ------------------------------------------------------------
  const og = meta.og ?? {};
  const ogEntries: Array<[string, string | undefined]> = [
    ['og:type', og.type ?? 'website'],
    ['og:title', og.title ?? meta.title],
    ['og:description', og.description ?? meta.description],
    ['og:url', og.url === undefined ? canonicalHref : abs(og.url)],
    ['og:site_name', og.siteName],
    ['og:locale', og.locale],
  ];
  for (const [property, content] of ogEntries) {
    if (content !== undefined) tags.push({ tag: 'meta', attrs: { property, content } });
  }
  if (og.image !== undefined) {
    const image = typeof og.image === 'string' ? { url: og.image } : og.image;
    tags.push({ tag: 'meta', attrs: { property: 'og:image', content: abs(image.url) } });
    if (image.width !== undefined) {
      tags.push({
        tag: 'meta',
        attrs: { property: 'og:image:width', content: String(image.width) },
      });
    }
    if (image.height !== undefined) {
      tags.push({
        tag: 'meta',
        attrs: { property: 'og:image:height', content: String(image.height) },
      });
    }
    if (image.alt !== undefined) {
      tags.push({ tag: 'meta', attrs: { property: 'og:image:alt', content: image.alt } });
    }
  }
  if (og.type === 'article') {
    const articleEntries: Array<[string, string | undefined]> = [
      ['article:published_time', og.publishedTime],
      ['article:modified_time', og.modifiedTime],
      ['article:author', og.author],
      ['article:section', og.section],
    ];
    for (const [property, content] of articleEntries) {
      if (content !== undefined) tags.push({ tag: 'meta', attrs: { property, content } });
    }
    for (const tag of og.tags ?? []) {
      tags.push({ tag: 'meta', attrs: { property: 'article:tag', content: tag } });
    }
  }

  // --- Twitter ---------------------------------------------------------------
  const twitter = meta.twitter ?? {};
  const twitterEntries: Array<[string, string | undefined]> = [
    ['twitter:card', twitter.card ?? (og.image === undefined ? 'summary' : 'summary_large_image')],
    ['twitter:site', twitter.site],
    ['twitter:creator', twitter.creator],
    ['twitter:title', og.title ?? meta.title],
    ['twitter:description', og.description ?? meta.description],
    ['twitter:image', twitter.image === undefined ? undefined : abs(twitter.image)],
    ['twitter:image:alt', twitter.imageAlt],
  ];
  for (const [name, content] of twitterEntries) {
    if (content !== undefined) tags.push({ tag: 'meta', attrs: { name, content } });
  }

  // --- hreflang --------------------------------------------------------------
  for (const alternate of hreflangSet(meta.alternates ?? [], meta.xDefault ?? canonicalHref)) {
    tags.push({
      tag: 'link',
      attrs: { rel: 'alternate', hreflang: alternate.hreflang, href: abs(alternate.href) },
    });
  }

  // --- theme-color per colour scheme ----------------------------------------
  for (const entry of meta.themeColor ?? []) {
    tags.push({
      tag: 'meta',
      attrs:
        entry.scheme === undefined
          ? { name: 'theme-color', content: entry.color }
          : {
              name: 'theme-color',
              media: `(prefers-color-scheme: ${entry.scheme})`,
              content: entry.color,
            },
    });
  }

  // --- JSON-LD ---------------------------------------------------------------
  for (const node of meta.ld ?? []) {
    tags.push({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      text: JSON.stringify(node),
    });
  }

  return tags;
}

/** Serialise head tags to HTML. `<script>` content is JSON, escaped for `</`. */
export function renderHeadTags(tags: readonly HeadTag[]): string {
  return tags
    .map((tag) => {
      if (tag.tag === 'title') return `<title>${escapeXml(tag.text ?? '')}</title>`;
      if (tag.tag === 'script') {
        const safe = (tag.text ?? '').replaceAll('</', '<\\/');
        return `<script${attributes(tag.attrs)}>${safe}</script>`;
      }
      return `<${tag.tag}${attributes(tag.attrs)}>`;
    })
    .join('\n');
}
