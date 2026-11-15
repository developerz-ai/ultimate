// Single responsibility: an RFC 5322 address-list header (`From`, `To`, `Cc`, `Reply-To`) →
// `{ address, name }` entries. Commas inside quotes, angle brackets and comments do not split;
// a group (`team: a@x.test, b@x.test;`) yields its members. Lenient: nothing here refuses.
// Parse the RAW header: RFC 2047 words are decoded in the phrase only, after the split (§5(3)).

import { decodeWords, encodedWordAt } from './mime-parse-headers';

export interface InboundAddress {
  /** The addr-spec, as written — never lower-cased: a local part is case-sensitive. */
  readonly address: string;
  /** The display phrase, RFC 2047 decoded, or `undefined`. */
  readonly name: string | undefined;
}

/** Top-level commas only; `;` closes a group and splits too. */
function entries(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let at = 0; at < value.length; at += 1) {
    const char = value.charAt(at);
    const word = encodedWordAt(value, at);
    if (word !== undefined) {
      current += word;
      at += word.length - 1;
      continue;
    }
    if (char === '\\') {
      current += char + value.charAt(at + 1);
      at += 1;
      continue;
    }
    if (char === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && char === '(') comment += 1;
    else if (!quoted && char === ')' && comment > 0) comment -= 1;
    else if (!quoted && comment === 0 && char === '<') angle += 1;
    else if (!quoted && comment === 0 && char === '>' && angle > 0) angle -= 1;
    else if (!quoted && comment === 0 && angle === 0 && (char === ',' || char === ';')) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/**
 * Comments (nested, `\` escapes) replaced by a space, in one pass. No regex in this file may
 * retry from every position of a sender's header: `(?:[^()\\]|\\.)*` over `(\(\(…` was quadratic.
 */
function stripComments(text: string): string {
  let out = '';
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '\\' && depth > 0) at += 1;
    else if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) out += ' ';
    } else if (depth === 0) out += char;
  }
  return out;
}

/** The first top-level comment's text, or `undefined`. */
function firstComment(text: string): string | undefined {
  const open = text.indexOf('(');
  if (open < 0) return undefined;
  const close = text.indexOf(')', open);
  return close < 0 ? undefined : text.slice(open + 1, close);
}

const unquote = (text: string): string => {
  const inner =
    text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
  return inner.replace(/\\(.)/g, '$1').trim();
};

/**
 * Where a group's display name ends: the first colon outside quotes and encoded words, before
 * any `<` or `@` — or -1. A scan, never `(?:"[^"]*"|=\?…\?=|[^"<@:])*:`, whose overlapping
 * alternatives backtrack exponentially on a long value with no colon.
 */
function groupColon(text: string): number {
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    const word = encodedWordAt(text, at);
    if (word !== undefined) at += word.length - 1;
    else if (char === ':') return at;
    else if (char === '<' || char === '@') return -1;
  }
  return -1;
}

/** `phrase <addr-spec> (comment)?` by index, never by backtracking regex. */
function angleForm(
  text: string,
): { readonly phrase: string; readonly address: string } | undefined {
  const close = text.lastIndexOf('>');
  if (close < 0) return undefined;
  const open = text.lastIndexOf('<', close);
  if (open < 0) return undefined;
  const address = text.slice(open + 1, close);
  if (address.includes('>')) return undefined;
  const tail = text.slice(close + 1).trim();
  if (tail !== '' && !(tail.startsWith('(') && tail.endsWith(')'))) return undefined;
  return { phrase: text.slice(0, open), address: address.trim() };
}

function one(entry: string): InboundAddress | undefined {
  let text = entry.trim();
  const colon = groupColon(text);
  if (colon >= 0) text = text.slice(colon + 1).trim();
  if (text === '') return undefined;
  const angle = angleForm(text);
  if (angle !== undefined) {
    const phrase = decodeWords(unquote(stripComments(angle.phrase).trim())).trim();
    return angle.address === ''
      ? undefined
      : { address: angle.address, name: phrase === '' ? undefined : phrase };
  }
  // A bare addr-spec, perhaps with a trailing comment as its name (`jane@x.test (Jane)`).
  const quoted = firstComment(text);
  const comment = quoted === undefined ? undefined : decodeWords(quoted).trim();
  const address = stripComments(text).trim();
  if (address === '') return undefined;
  return { address, name: comment === undefined || comment === '' ? undefined : comment };
}

export function parseAddressList(value: string | undefined): readonly InboundAddress[] {
  if (value === undefined) return [];
  return entries(value).flatMap((entry) => {
    const parsed = one(entry);
    return parsed === undefined ? [] : [parsed];
  });
}
