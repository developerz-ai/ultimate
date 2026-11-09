// The tree a markdown body parses to, and the caps every construct is held to. Text is always a
// `text` leaf rendered as a JSX text node, so nothing in a body can become markup.

/** A body past this length renders its remainder as one plain-text block, never a thrown page. */
export const MARKDOWN_MAX_CHARS = 262_144;
/** Quotes and lists nest at most this deep; deeper lines are paragraph text. */
export const MARKDOWN_MAX_BLOCK_DEPTH = 8;
/** Emphasis, links and strikethrough nest at most this deep; deeper delimiters are text. */
export const MARKDOWN_MAX_INLINE_DEPTH = 12;
/** A link destination longer than this is not a link: it is read in one bounded scan. */
export const MARKDOWN_MAX_URL = 2_048;

export type MarkdownInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'em' | 'strong' | 'del'; readonly children: readonly MarkdownInline[] }
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly title?: string | undefined;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'break' };

export type TableAlign = 'start' | 'center' | 'end' | null;

export interface MarkdownListItem {
  /** `null` for a plain item; a boolean for a task item. */
  readonly checked: boolean | null;
  readonly children: readonly MarkdownBlock[];
}

export type MarkdownBlock =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly kind: 'paragraph'; readonly children: readonly MarkdownInline[] }
  /** `open`: the fence has not closed yet — a body still streaming in. */
  | { readonly kind: 'code'; readonly info: string; readonly text: string; readonly open: boolean }
  | { readonly kind: 'quote'; readonly children: readonly MarkdownBlock[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly MarkdownListItem[];
    }
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly head: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    }
  | { readonly kind: 'rule' }
  /** What a cap left unparsed, verbatim. */
  | { readonly kind: 'text'; readonly text: string };
