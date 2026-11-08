// Strings a `pattern` accepts, built by walking the pattern rather than guessing shapes — the ONE
// generator, read by the input walker (`sample-draw.ts`, `sample-seeded.ts`) and by
// `@ultimat3/testing`'s seed values. The common subset only — literals, classes, `.`, groups,
// alternation, quantifiers, anchors — and an honest `[]` past it (lookaround, `\b`, `\p{…}`).

import { mulberry32 } from './sample-random';

type Node =
  | { readonly kind: 'chars'; readonly chars: readonly string[] }
  | { readonly kind: 'alt'; readonly branches: readonly (readonly Piece[])[] }
  | { readonly kind: 'empty' };

interface Piece {
  readonly node: Node;
  readonly min: number;
  readonly max: number;
}

/** How far past its floor an unbounded quantifier draws: enough to vary, short enough to store. */
const UNBOUNDED_SPAN = 6;

/** The universe a class or `.` picks from: printable ASCII, so every sample is plain text. */
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const DIGITS = PRINTABLE.filter((c) => c >= '0' && c <= '9');
const WORD = PRINTABLE.filter((c) => /\w/.test(c));
const SPACE = [' ', '\t'];

const SHORTHAND: Readonly<Record<string, readonly string[]>> = {
  d: DIGITS,
  D: PRINTABLE.filter((c) => !DIGITS.includes(c)),
  w: WORD,
  W: PRINTABLE.filter((c) => !WORD.includes(c)),
  s: SPACE,
  S: PRINTABLE.filter((c) => c !== ' '),
};

const CONTROL: Readonly<Record<string, string>> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v' };

class Parser {
  private at = 0;
  /** The first construct past the subset; set once, and it ends the walk. */
  private refused: string | undefined;
  constructor(private readonly source: string) {}

  /** The tree, or `undefined` when any part of the pattern is past the subset. */
  parse(): Node | undefined {
    const node = this.alternation();
    if (this.refused === undefined && this.at < this.source.length) this.refuse('a stray ")"');
    return this.refused === undefined ? node : undefined;
  }

  /** Records the refusal and moves to the end, so every loop above stops on its next look. */
  private refuse(construct: string): readonly string[] {
    this.refused ??= construct;
    this.at = this.source.length;
    return [];
  }

  private peek(): string | undefined {
    return this.source[this.at];
  }

  private alternation(): Node {
    const branches: Piece[][] = [this.sequence()];
    while (this.peek() === '|') {
      this.at += 1;
      branches.push(this.sequence());
    }
    return { kind: 'alt', branches };
  }

  private sequence(): Piece[] {
    const pieces: Piece[] = [];
    for (let c = this.peek(); c !== undefined && c !== '|' && c !== ')'; c = this.peek()) {
      const node = this.atom();
      const [min, max] = this.quantifier();
      pieces.push({ node, min, max });
    }
    return pieces;
  }

  private quantifier(): readonly [number, number] {
    const c = this.peek();
    const bounds = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.at));
    let range: readonly [number, number] | undefined;
    if (c === '*') range = [0, UNBOUNDED_SPAN];
    else if (c === '+') range = [1, 1 + UNBOUNDED_SPAN];
    else if (c === '?') range = [0, 1];
    else if (bounds !== null) {
      const low = Number(bounds[1]);
      const high =
        bounds[2] === undefined ? low : bounds[3] === '' ? low + UNBOUNDED_SPAN : Number(bounds[3]);
      range = [low, high];
    }
    if (range === undefined) return [1, 1];
    this.at += bounds !== null && c === '{' ? bounds[0].length : 1;
    // A lazy quantifier matches the same strings; only the engine's preference differs.
    if (this.peek() === '?') this.at += 1;
    return range;
  }

  private atom(): Node {
    const c = this.peek() as string;
    this.at += 1;
    if (c === '^' || c === '$') return { kind: 'empty' };
    if (c === '.') return { kind: 'chars', chars: PRINTABLE };
    if (c === '[') return { kind: 'chars', chars: this.charClass() };
    if (c === '(') return this.group();
    if (c === '\\') return { kind: 'chars', chars: this.escape(false) };
    if (c === '*' || c === '+' || c === '?' || c === '{')
      return { kind: 'chars', chars: this.refuse(`a bare "${c}"`) };
    return { kind: 'chars', chars: [c] };
  }

  private group(): Node {
    if (this.peek() === '?') {
      const head = this.source.slice(this.at, this.at + 3);
      if (head.startsWith('?:')) this.at += 2;
      else if (/^\?<[A-Za-z_$]/.test(head) && this.source.includes('>', this.at)) {
        this.at = this.source.indexOf('>', this.at) + 1;
      } else return { kind: 'chars', chars: this.refuse(`the lookaround "(${head}"`) };
    }
    const inner = this.alternation();
    if (this.peek() !== ')') return { kind: 'chars', chars: this.refuse('an unclosed group') };
    this.at += 1;
    return inner;
  }

  private escape(inClass: boolean): readonly string[] {
    const c = this.peek();
    if (c === undefined) return this.refuse('a trailing backslash');
    this.at += 1;
    const shorthand = Object.hasOwn(SHORTHAND, c) ? SHORTHAND[c] : undefined;
    if (shorthand !== undefined) return shorthand;
    const control = Object.hasOwn(CONTROL, c) ? CONTROL[c] : undefined;
    if (control !== undefined) return [control];
    const hex = c === 'x' ? 2 : c === 'u' ? 4 : 0;
    if (hex > 0) {
      const digits = this.source.slice(this.at, this.at + hex);
      if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex) return this.refuse(`\\${c}`);
      this.at += hex;
      return [String.fromCharCode(Number.parseInt(digits, 16))];
    }
    // `\b`, `\B`, a backreference, `\p{…}`, `\k<…>`, `\0`: a position or a reference, not a char.
    if (/[A-Za-z0-9]/.test(c)) return this.refuse(`\\${c}${inClass ? ' in a class' : ''}`);
    return [c];
  }

  /** The members of `[…]`, drawn from printable ASCII; a negated class is its complement there. */
  private charClass(): readonly string[] {
    const negated = this.peek() === '^';
    if (negated) this.at += 1;
    const members = new Set<string>();
    let first = true;
    for (let c = this.peek(); c !== ']' || first; c = this.peek()) {
      if (c === undefined) return this.refuse('an unclosed class');
      first = false;
      const low = this.classMember();
      if (low.length === 1 && this.peek() === '-' && this.source[this.at + 1] !== ']') {
        this.at += 1;
        const high = this.classMember();
        if (high.length !== 1) return this.refuse('a range ending in a shorthand');
        const [from, to] = [(low[0] as string).charCodeAt(0), (high[0] as string).charCodeAt(0)];
        // Past printable ASCII the range's own first member stands in, so `[À-ÿ]` still yields one.
        const inside = PRINTABLE.filter((ch) => ch.charCodeAt(0) >= from && ch.charCodeAt(0) <= to);
        for (const ch of inside.length > 0 ? inside : [String.fromCharCode(from)]) members.add(ch);
      } else {
        for (const ch of low) members.add(ch);
      }
    }
    this.at += 1;
    return negated ? PRINTABLE.filter((ch) => !members.has(ch)) : [...members];
  }

  private classMember(): readonly string[] {
    const c = this.peek() as string;
    this.at += 1;
    return c === '\\' ? this.escape(true) : [c];
  }
}

const draw = (node: Node, random: () => number): string => {
  const pick = <T>(items: readonly T[]): T | undefined =>
    items[Math.floor(random() * items.length)];
  if (node.kind === 'empty') return '';
  if (node.kind === 'chars') return pick(node.chars) ?? '';
  const branch = pick(node.branches) ?? [];
  return branch
    .map((piece) => {
      const count = piece.min + Math.floor(random() * (piece.max - piece.min + 1));
      return Array.from({ length: count }, () => draw(piece.node, random)).join('');
    })
    .join('');
};

/** Tries per sample: a draw that crosses an anchor (`a^b`) or a flag is retried, never returned. */
const ATTEMPTS = 8;

/**
 * Up to `count` distinct strings `pattern.test` accepts, the same ones for the same `seed` on any
 * machine. Empty when the pattern is past the subset, or when no draw lands inside it. `seed` is a
 * number because this tier cannot import `fnv1a`; a caller with a text seed hashes it first.
 */
export function patternSamples(pattern: RegExp, seed: number, count = 4): readonly string[] {
  const tree = new Parser(pattern.source).parse();
  if (tree === undefined) return [];
  const random = mulberry32(seed);
  // `lastIndex` would make `test` stateful under `g`/`y`; a copy without them judges each draw.
  const judge = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const out: string[] = [];
  for (let attempt = 0; attempt < count * ATTEMPTS && out.length < count; attempt += 1) {
    const sample = draw(tree, random);
    if (judge.test(sample) && !out.includes(sample)) out.push(sample);
  }
  return out;
}
