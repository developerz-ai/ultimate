// Inline markdown in linear time: escapes, code spans, brackets and delimiter runs are each found
// in ONE pass up front, so a body of 100 KB of `*` and `[` never rescans. A link whose scheme is
// not http, https, mailto or relative prints as its source text. Raw HTML is text.

import { MARKDOWN_MAX_INLINE_DEPTH, MARKDOWN_MAX_URL, type MarkdownInline } from './markdown-tree';

const PUNCT = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const ALNUM = /[\p{L}\p{N}]/u;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * A destination a reader may follow: no scheme (relative, `/path`, `#frag`) or one of three. Read
 * off the string with C0 controls and spaces removed, as a browser reads `java\tscript:`.
 */
export function safeMarkdownUrl(url: string): boolean {
  const stripped = [...url]
    .filter((char) => (char.codePointAt(0) ?? 0) > 0x20 && char !== '\u007f')
    .join('');
  const scheme = SCHEME.exec(stripped);
  return scheme === null || SAFE_SCHEMES.has(scheme[0].toLowerCase());
}

interface Run {
  readonly start: number;
  readonly len: number;
  readonly char: string;
  readonly open: boolean;
  /** The next run, left to right, that can close this one; -1 for none. */
  close: number;
}

interface Scan {
  /** A backslash that escapes the next character: dropped, and its next character is literal. */
  readonly escapes: Uint8Array;
  /** Start of a code span → [content start, content end, span end]. */
  readonly code: Map<number, readonly [number, number, number]>;
  /** `[` → its matching `]`. */
  readonly bracket: Map<number, number>;
  readonly runs: Map<number, Run>;
  readonly runAt: readonly Run[];
  /** Where a bare destination starting here ends: whitespace, or the `)` that unbalances it. */
  readonly destEnd: Int32Array;
}

/**
 * Every bare destination's end in one right-to-left pass, so a body of `[](` repeated never
 * rescans: the end is the first whitespace, or the first `)` where the paren depth from `i` drops
 * below zero — the next position whose prefix depth is SMALLER, found with a monotonic stack.
 */
function destinationEnds(src: string): Int32Array {
  const n = src.length;
  const depth = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1)
    depth[i + 1] = (depth[i] ?? 0) + (src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0);
  const end = new Int32Array(n + 1);
  const stack: number[] = [n];
  let space = n;
  end[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (SPACE.test(src[i] ?? '')) space = i;
    // `k` is a prefix index; the `)` that drops below depth[i] is the character at k - 1.
    while (stack.length > 0 && (depth[stack[stack.length - 1] ?? 0] ?? 0) >= (depth[i] ?? 0))
      stack.pop();
    const drop = stack.length === 0 ? n + 1 : (stack[stack.length - 1] ?? n + 1);
    end[i] = Math.min(space, drop - 1);
    stack.push(i);
  }
  return end;
}

const isSpace = (char: string | undefined): boolean => char === undefined || SPACE.test(char);
const isPunct = (char: string | undefined): boolean => char !== undefined && PUNCT.test(char);

function scan(src: string): Scan {
  const n = src.length;
  const escapes = new Uint8Array(n);
  for (let i = 0; i < n - 1; i += 1) {
    if (src[i] === '\\' && escapes[i] === 0 && PUNCT.test(src[i + 1] ?? '')) {
      escapes[i] = 1;
      escapes[i + 1] = 2;
    }
  }
  // Backtick runs by length, in order; a run closes at the NEXT run of its own length.
  const ticks: { start: number; len: number }[] = [];
  for (let i = 0; i < n; ) {
    if (src[i] === '`' && escapes[i] === 0) {
      let j = i;
      while (src[j] === '`') j += 1;
      ticks.push({ start: i, len: j - i });
      i = j;
    } else i += 1;
  }
  const nextSame = new Map<number, number>();
  const following: number[] = new Array(ticks.length).fill(-1);
  for (let k = ticks.length - 1; k >= 0; k -= 1) {
    const tick = ticks[k];
    if (tick === undefined) continue;
    following[k] = nextSame.get(tick.len) ?? -1;
    nextSame.set(tick.len, k);
  }
  const code = new Map<number, readonly [number, number, number]>();
  const covered = new Uint8Array(n);
  let until = 0;
  ticks.forEach((tick, k) => {
    const closer = ticks[following[k] ?? -1];
    if (tick.start < until || closer === undefined) return;
    const end = closer.start + closer.len;
    code.set(tick.start, [tick.start + tick.len, closer.start, end]);
    covered.fill(1, tick.start, end);
    until = end;
  });
  const usable = (i: number): boolean => covered[i] === 0 && escapes[i] === 0;
  const bracket = new Map<number, number>();
  const stack: number[] = [];
  const runAt: Run[] = [];
  for (let i = 0; i < n; i += 1) {
    const char = src[i];
    if (!usable(i)) continue;
    if (char === '[') stack.push(i);
    else if (char === ']') {
      const open = stack.pop();
      if (open !== undefined) bracket.set(open, i);
    } else if (char === '*' || char === '_' || char === '~') {
      let j = i;
      while (src[j] === char && usable(j)) j += 1;
      const len = j - i;
      const before = src[i - 1];
      const after = src[j];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const word = char === '_';
      const valid = char === '~' ? len === 2 : len <= 3;
      runAt.push({
        start: i,
        len,
        char,
        open: valid && left && !(word && ALNUM.test(before ?? '')),
        close: valid && right && !(word && ALNUM.test(after ?? '')) ? 1 : 0,
      });
      i = j - 1;
    }
  }
  const latest = new Map<string, number>();
  for (let k = runAt.length - 1; k >= 0; k -= 1) {
    const run = runAt[k];
    if (run === undefined) continue;
    const canClose = run.close === 1;
    run.close = latest.get(`${run.char}${run.len}`) ?? -1;
    if (canClose) latest.set(`${run.char}${run.len}`, k);
  }
  const runs = new Map(runAt.map((run) => [run.start, run] as const));
  return { escapes, code, bracket, runs, runAt, destEnd: destinationEnds(src) };
}

/** `indexOf`, but never past `limit`: an unclosed `<` must not rescan the rest of the body. */
function within(src: string, char: string, from: number, limit: number): number {
  for (let i = from; i < limit; i += 1) if (src[i] === char) return i;
  return -1;
}

/** `(dest "title")` after a `]` at `at`, read in one bounded scan; null when it is not one. */
function linkTail(
  src: string,
  at: number,
  destEnd: Int32Array,
): { href: string; title?: string; end: number } | null {
  if (src[at] !== '(') return null;
  let i = at + 1;
  const limit = Math.min(src.length, at + MARKDOWN_MAX_URL + 600);
  while (i < limit && (src[i] === ' ' || src[i] === '\n')) i += 1;
  let href = '';
  if (src[i] === '<') {
    const close = within(src, '>', i, limit);
    if (close === -1 || src.slice(i, close).includes('\n')) return null;
    href = src.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    i = destEnd[i] ?? i;
    href = src.slice(from, i);
  }
  if (href.length > MARKDOWN_MAX_URL) return null;
  while (i < limit && (src[i] === ' ' || src[i] === '\n')) i += 1;
  let title: string | undefined;
  const quote = src[i];
  if (quote === '"' || quote === "'") {
    const close = within(src, quote, i + 1, limit);
    if (close === -1) return null;
    title = src.slice(i + 1, close);
    i = close + 1;
    while (i < limit && src[i] === ' ') i += 1;
  }
  if (src[i] !== ')') return null;
  return title === undefined ? { href, end: i + 1 } : { href, title, end: i + 1 };
}

const ANGLE = /<((?:https?:\/\/|mailto:)[^\s<>]{1,2048})>/y;
const BARE = /(?:https?:\/\/|www\.)[^\s<]{1,2048}/y;

/** A bare URL's end: trailing punctuation is the sentence's, and an unbalanced `)` too. */
function trimBare(url: string): string {
  let end = url.length;
  while (end > 0 && /[.,:;!?"'*_~]/.test(url[end - 1] ?? '')) end -= 1;
  let out = url.slice(0, end);
  while (out.endsWith(')') && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

export const plainText = (nodes: readonly MarkdownInline[]): string =>
  nodes
    .map((node) =>
      node.kind === 'text' || node.kind === 'code'
        ? node.text
        : node.kind === 'image'
          ? node.alt
          : node.kind === 'break'
            ? ' '
            : plainText(node.children),
    )
    .join('');

/** The inline tree of one block's text. */
export function parseInline(src: string): readonly MarkdownInline[] {
  const found = scan(src);
  const walk = (from: number, to: number, depth: number): MarkdownInline[] => {
    const out: MarkdownInline[] = [];
    // Pieces, joined once per flush: a string grown and re-read per line (`endsWith`, `slice`) is
    // a rope flattened per line, and a long paragraph went quadratic on it.
    let pieces: string[] = [];
    const add = (piece: string): void => {
      if (piece !== '') pieces.push(piece);
    };
    const last = (): string => {
      const piece = pieces[pieces.length - 1] ?? '';
      return piece[piece.length - 1] ?? '';
    };
    const dropLast = (): void => {
      const piece = pieces.pop() ?? '';
      if (piece.length > 1) pieces.push(piece.slice(0, -1));
    };
    const flush = (): void => {
      if (pieces.length > 0) out.push({ kind: 'text', text: pieces.join('') });
      pieces = [];
    };
    const nest = depth < MARKDOWN_MAX_INLINE_DEPTH;
    let i = from;
    while (i < to) {
      const char = src[i] ?? '';
      if (found.escapes[i] === 1) {
        add(src[i + 1] ?? '');
        i += 2;
        continue;
      }
      const span = found.code.get(i);
      if (span !== undefined && span[2] <= to) {
        flush();
        let body = src.slice(span[0], span[1]).replace(/\n/g, ' ');
        if (body.length > 1 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '')
          body = body.slice(1, -1);
        out.push({ kind: 'code', text: body });
        i = span[2];
        continue;
      }
      const image = char === '!' && src[i + 1] === '[';
      const open = image ? i + 1 : i;
      const close = src[open] === '[' ? found.bracket.get(open) : undefined;
      if (close !== undefined && close < to && found.escapes[open] === 0) {
        const tail = linkTail(src, close + 1, found.destEnd);
        if (tail !== null && tail.end <= to) {
          flush();
          if (!safeMarkdownUrl(tail.href)) out.push({ kind: 'text', text: src.slice(i, tail.end) });
          else if (image)
            out.push({
              kind: 'image',
              src: tail.href,
              alt: plainText(walk(open + 1, close, depth + 1)),
            });
          else
            out.push({
              kind: 'link',
              href: tail.href,
              ...(tail.title === undefined ? {} : { title: tail.title }),
              children: nest
                ? walk(open + 1, close, depth + 1)
                : [{ kind: 'text', text: src.slice(open + 1, close) }],
            });
          i = tail.end;
          continue;
        }
      }
      if (char === '<') {
        ANGLE.lastIndex = i;
        const angle = ANGLE.exec(src);
        if (angle !== null && i + angle[0].length <= to) {
          flush();
          out.push({
            kind: 'link',
            href: angle[1] ?? '',
            children: [{ kind: 'text', text: angle[1] ?? '' }],
          });
          i += angle[0].length;
          continue;
        }
      }
      if ((char === 'h' || char === 'w') && !ALNUM.test(src[i - 1] ?? ' ')) {
        BARE.lastIndex = i;
        const bare = BARE.exec(src);
        if (bare !== null) {
          const url = trimBare(bare[0].slice(0, to - i));
          if (url.length > 4 && url !== 'www.') {
            flush();
            out.push({
              kind: 'link',
              href: url.startsWith('www.') ? `https://${url}` : url,
              children: [{ kind: 'text', text: url }],
            });
            i += url.length;
            continue;
          }
        }
      }
      const run = found.runs.get(i);
      if (run !== undefined) {
        const closer = found.runAt[run.close];
        if (run.open && nest && closer !== undefined && closer.start + closer.len <= to) {
          flush();
          const inner = walk(i + run.len, closer.start, depth + 1);
          const kind = run.char === '~' ? 'del' : run.len === 1 ? 'em' : 'strong';
          out.push(
            run.len === 3
              ? { kind: 'strong', children: [{ kind: 'em', children: inner }] }
              : { kind, children: inner },
          );
          i = closer.start + closer.len;
        } else {
          add(src.slice(i, i + run.len));
          i += run.len;
        }
        continue;
      }
      if (char === '\n') {
        let spaces = 0;
        while (last() === ' ') {
          dropLast();
          spaces += 1;
        }
        const slash = spaces === 0 && last() === '\\';
        if (slash) dropLast();
        const hard = spaces >= 2 || slash;
        if (hard) {
          flush();
          out.push({ kind: 'break' });
        } else add('\n');
        i += 1;
        continue;
      }
      add(char);
      i += 1;
    }
    flush();
    return out;
  };
  return walk(0, src.length, 0);
}
