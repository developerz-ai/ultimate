// A small tokenizer: a language is an ordered list of sticky regex rules, and the text is cut into
// classed runs whose JOINED text is the input byte for byte. Classes only — the colours are roles,
// so a theme recolours. Unknown language: one plain run. `defineLanguage` is the mechanism.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';

/** The closed set of classes a run can carry; `CodeBlock.module.scss` styles each by role. */
export const TOKEN_KINDS = [
  'plain',
  'keyword',
  'string',
  'number',
  'comment',
  'type',
  'function',
  'property',
  'tag',
  'attribute',
  'operator',
  'punctuation',
  'inserted',
  'deleted',
  'meta',
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export interface TokenRule {
  readonly kind: TokenKind;
  readonly pattern: RegExp;
}

export interface Language {
  readonly name: string;
  /** Fence info strings that also name it: `typescript`, `js`, `sh`. */
  readonly aliases: readonly string[];
  readonly rules: readonly TokenRule[];
}

/** Each rule compiled once, sticky, so a match is tried AT a position and never searches ahead. */
const COMPILED = new WeakMap<Language, readonly { kind: TokenKind; re: RegExp }[]>();

function emptyMatchError(language: string, rule: TokenRule): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `defineLanguage(${renderCauseValue(language)}): the ${rule.kind} rule ${renderCauseValue(String(rule.pattern))} can match the empty string, which would cut no text and loop`,
    fix: "defineLanguage('mylang', [{ kind: 'keyword', pattern: /\\b(?:if|else)\\b/ }])   # every rule must consume at least one character",
  });
}

/**
 * Declares a language. A rule whose pattern can match empty is refused here, where it is written,
 * rather than discovered as a stall on someone's text.
 */
export function defineLanguage(
  name: string,
  rules: readonly TokenRule[],
  aliases: readonly string[] = [],
): Language {
  const compiled = rules.map((rule) => {
    const re = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace(/[gy]/g, '')}y`);
    re.lastIndex = 0;
    if (re.test('')) throw emptyMatchError(name, rule);
    return { kind: rule.kind, re };
  });
  const language: Language = { name, aliases, rules };
  COMPILED.set(language, compiled);
  return language;
}

/** The language a fence's info string names, among those the caller passed. */
export function findLanguage(
  info: string | undefined,
  languages: readonly Language[] | undefined,
): Language | undefined {
  if (info === undefined || languages === undefined) return undefined;
  const name = info.trim().split(/\s/, 1)[0]?.toLowerCase() ?? '';
  if (name === '') return undefined;
  return languages.find((language) => language.name === name || language.aliases.includes(name));
}

const WORD = /[\p{L}\p{N}_$]+/uy;

/** The runs of `text`. Adjacent runs of one kind are merged; the joined runs equal `text`. */
export function highlight(text: string, language: Language | undefined): readonly Token[] {
  const rules = language === undefined ? undefined : COMPILED.get(language);
  if (rules === undefined || rules.length === 0)
    return text === '' ? [] : [{ kind: 'plain', text }];
  const out: Token[] = [];
  const push = (kind: TokenKind, piece: string): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind)
      out[out.length - 1] = { kind, text: last.text + piece };
    else out.push({ kind, text: piece });
  };
  let at = 0;
  while (at < text.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = at;
      const found = rule.re.exec(text);
      // Zero-width is refused at definition, but a lookahead can still match empty mid-text.
      if (found === null || found[0].length === 0) continue;
      push(rule.kind, found[0]);
      at += found[0].length;
      matched = true;
      break;
    }
    if (matched) continue;
    // A whole word at once, so an identifier is never split for a keyword rule to bite its tail.
    WORD.lastIndex = at;
    const word = WORD.exec(text);
    const piece =
      word === null
        ? (text.codePointAt(at) ?? 0) > 0xffff
          ? text.slice(at, at + 2)
          : (text[at] ?? '')
        : word[0];
    push('plain', piece);
    at += piece.length;
  }
  return out;
}
