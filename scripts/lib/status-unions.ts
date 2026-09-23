// Discriminated unions read as their discriminant's literal SET: `type S<T> = | { status: 'a' } |
// { status: 'b'; data: T }` is the set {a, b}. `render-modes.ts`'s literal-set reader cannot see one
// — its bodies hold `;` and braces — and `AsyncState` is written exactly this way, so a second copy
// of it under another name was invisible to the rule that exists to refuse second copies.

import { maskLiterals, stripComments } from '@ultimat3/core';
import { lineOf } from './source-scan';

export interface StatusUnion {
  readonly name: string;
  readonly line: number;
  readonly members: readonly string[];
}

const DECLARATION =
  /^[\t ]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/gm;
const DISCRIMINANT = /\bstatus\??\s*:\s*(['"])([^'"]+)\1/g;

/** Index of the `;` ending the declaration body at depth 0, or the text's end. */
function bodyEnd(masked: string, from: number): number {
  let depth = 0;
  for (let index = from; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '{' || char === '(' || char === '[' || char === '<') depth += 1;
    // `=>` in a function type closes nothing it opened.
    else if (char === '>' && masked[index - 1] === '=') continue;
    else if (char === '}' || char === ')' || char === ']' || char === '>') depth -= 1;
    else if (char === ';' && depth <= 0) return index;
  }
  return masked.length;
}

/**
 * Every `type` whose body is a union of object types each naming a `status:` literal. Two or more
 * arms, or it is a record with a status field rather than a vocabulary.
 */
export function scanStatusUnions(source: string): readonly StatusUnion[] {
  const text = stripComments(source);
  const masked = maskLiterals(source);
  const found: StatusUnion[] = [];
  for (const declaration of masked.matchAll(DECLARATION)) {
    const start = declaration.index + declaration[0].length;
    const body = text.slice(start, bodyEnd(masked, start));
    if (!/^\s*\|?\s*\{/.test(body)) continue;
    const members = [...new Set([...body.matchAll(DISCRIMINANT)].map((m) => m[2] as string))];
    if (members.length < 2) continue;
    found.push({ name: declaration[1] as string, line: lineOf(text, declaration.index), members });
  }
  return found;
}
