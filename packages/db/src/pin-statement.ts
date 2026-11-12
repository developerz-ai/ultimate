// Single responsibility: which of the few statements that move a pin's `statement_timeout` a text
// is — a transaction end, a savepoint verb, a RESET, a SET or a `set_config` — read from its
// leading words in ONE linear pass. Statement text is library input: no backtracking regex reads
// it, and a long statement stops being read after `PIN_WORDS_MAX` words.

/** More words than any statement recognised here has, so a bulk INSERT is dropped after a dozen. */
export const PIN_WORDS_MAX = 12;

export type PinStatement =
  | { readonly kind: 'end' }
  | { readonly kind: 'savepoint' | 'rollback-to' | 'release'; readonly name: string }
  | { readonly kind: 'role-bound' }
  | { readonly kind: 'set'; readonly value: string };

const PUNCTUATION = '=(),;';

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** The index just past the quote closing the one at `start` (`''`/`""` escape it), or -1. */
function quotedEnd(text: string, start: number, quote: string): number {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] !== quote) at += 1;
    else if (text[at + 1] === quote) at += 2;
    else return at + 1;
  }
  return -1;
}

/**
 * The words of `text`: a quoted identifier or literal whole, each of `= ( ) , ;` alone, any other
 * run of non-space characters as one. One trailing `;` dropped. `undefined` past `PIN_WORDS_MAX`
 * words or at an unterminated quote: neither is a statement this file recognises.
 */
export function pinWords(text: string): readonly string[] | undefined {
  const words: string[] = [];
  let at = 0;
  for (;;) {
    while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
    if (at >= text.length) break;
    if (words.length === PIN_WORDS_MAX) return undefined;
    const char = text[at] ?? '';
    let end = at + 1;
    if (char === '"' || char === "'") {
      end = quotedEnd(text, at, char);
      if (end === -1) return undefined;
    } else if (!PUNCTUATION.includes(char)) {
      while (end < text.length && !isSpace(text.charCodeAt(end))) {
        const next = text[end] ?? '';
        if (PUNCTUATION.includes(next) || next === '"' || next === "'") break;
        end += 1;
      }
    }
    words.push(text.slice(at, end));
    at = end;
  }
  if (words.at(-1) === ';') words.pop();
  return words;
}

const UNQUOTED_NAME = /^[a-z_][\w$]*$/i;

/** A savepoint name as the server compares it: unquoted folds to lower case, quoted is exact. */
function nameOf(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  if (word.startsWith('"'))
    return word.length > 2 ? word.slice(1, -1).replaceAll('""', '"') : undefined;
  return UNQUOTED_NAME.test(word) ? word.toLowerCase() : undefined;
}

/** `[savepoint] name` as the last one or two words from `from`. */
function savepointAt(
  words: readonly string[],
  from: number,
  optional: boolean,
): string | undefined {
  const at = optional && words[from]?.toLowerCase() === 'savepoint' ? from + 1 : from;
  return at === words.length - 1 ? nameOf(words[at]) : undefined;
}

/** `rollback [work|transaction] to [savepoint] name`, or a bare transaction end. */
function rollbackOf(words: readonly string[]): PinStatement | undefined {
  const at = ['work', 'transaction'].includes(words[1]?.toLowerCase() ?? '') ? 2 : 1;
  if (at === words.length) return { kind: 'end' };
  if (words[at]?.toLowerCase() !== 'to') return undefined;
  const name = savepointAt(words, at + 1, true);
  return name === undefined ? undefined : { kind: 'rollback-to', name };
}

/** `set [local|session] statement_timeout {=|to} value` — `default` is the role's. */
function setOf(words: readonly string[]): PinStatement | undefined {
  const at = ['local', 'session'].includes(words[1]?.toLowerCase() ?? '') ? 2 : 1;
  if (words[at]?.toLowerCase() !== 'statement_timeout' || words.length !== at + 3) return undefined;
  if (!['=', 'to'].includes(words[at + 1]?.toLowerCase() ?? '')) return undefined;
  const value = words[at + 2] ?? '';
  return value.toLowerCase() === 'default' ? { kind: 'role-bound' } : { kind: 'set', value };
}

/** `select set_config('statement_timeout', 'value', true|false)`. */
function setConfigOf(words: readonly string[]): PinStatement | undefined {
  const [, fn, open, key, , value, , local, close] = words;
  const shape =
    words.length === 9 &&
    fn?.toLowerCase() === 'set_config' &&
    open === '(' &&
    key?.toLowerCase() === "'statement_timeout'" &&
    words[4] === ',' &&
    words[6] === ',' &&
    ['true', 'false'].includes(local?.toLowerCase() ?? '') &&
    close === ')' &&
    value?.startsWith("'") === true;
  return shape
    ? { kind: 'set', value: (value ?? '').slice(1, -1).replaceAll("''", "'") }
    : undefined;
}

export function pinStatement(text: string): PinStatement | undefined {
  const words = pinWords(text);
  if (words === undefined) return undefined;
  const verb = words[0]?.toLowerCase();
  switch (verb) {
    case 'commit':
    case 'end':
    case 'abort': {
      const tail = words[1]?.toLowerCase();
      const bare =
        words.length === 1 || (words.length === 2 && ['work', 'transaction'].includes(tail ?? ''));
      return bare ? { kind: 'end' } : undefined;
    }
    case 'rollback':
      return rollbackOf(words);
    case 'savepoint': {
      const name = savepointAt(words, 1, false);
      return name === undefined ? undefined : { kind: 'savepoint', name };
    }
    case 'release': {
      const name = savepointAt(words, 1, true);
      return name === undefined ? undefined : { kind: 'release', name };
    }
    case 'reset': {
      const what = words[1]?.toLowerCase();
      const known = words.length === 2 && (what === 'statement_timeout' || what === 'all');
      return known ? { kind: 'role-bound' } : undefined;
    }
    case 'set':
      return setOf(words);
    case 'select':
      return setConfigOf(words);
    default:
      return undefined;
  }
}
