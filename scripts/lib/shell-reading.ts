// Reading one line of shell text the way a pasted `fix:` will be read: where segments open, where a
// comment starts, where prose punctuation sits — each OUTSIDE quotes. Text only; what counts as a
// command position is `fix-shell-arg-scan.ts`'s question (security audit of plan 101 sweep 1c, M2).

/**
 * Between the command word and the substitution, OUTSIDE quotes: any of these and the line is prose.
 * Inside quotes they are the command's own text — `psql -c "select id, name …"` — and reading them
 * as prose hid every substitution after them (security audit of plan 101 sweep 1c, M2).
 */
const PROSE_MARKERS = new Set([',', '(', '—']);

/** What opens a new shell segment outside quotes: a pipe, a `;`, a `&`, a `(`. */
const SEGMENT_OPENERS = new Set(['|', ';', '&', '(']);

export interface ShellReading {
  /** The last segment opener outside quotes, or -1. */
  readonly opener: number;
  /** A `#` starting a word, outside quotes: everything after it is a comment. */
  readonly commented: boolean;
  /** Prose punctuation outside quotes, at any position. */
  readonly prose: readonly number[];
}

/** One pass over shell text with quote state: where segments open, comments start, prose shows. */
export function readShell(text: string): ShellReading {
  let quote: string | undefined;
  let opener = -1;
  const prose: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || (ch === "'" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) {
      // An apostrophe INSIDE a word (`the run's steps`) is English, not a quote: read as one, it
      // swallowed the em dash after it and turned a sentence into a command.
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) {
      return { opener, commented: true, prose };
    } else if (SEGMENT_OPENERS.has(ch)) {
      opener = i;
    } else if (PROSE_MARKERS.has(ch)) {
      prose.push(i);
    }
  }
  return { opener, commented: false, prose };
}
