// The global `fetch` handed on as a VALUE in one file's text — `rpc({ fetch })`, `fetch: fetch`,
// `const f = window.fetch`, `make(globalThis.fetch)` — the bypass `transportCalls` cannot see: the
// call happens in the module it was passed to, as `options.fetch(url)`, a property no rule reads.
// Pure, beside `transport-calls.ts`; the caller decides which file may hold it.

import { maskLiterals } from '@ultimat3/core';
import type { TransportCall } from './transport-calls';
import { bindsFetch } from './transport-calls';
import { lineIndex } from './ts-scan';

/**
 * `fetch` not after `.`/a word char (a property on another object, `prefetch`), optionally behind
 * the global object, not followed by a word char (`fetchUser`) — and never a call, which is
 * `transportCalls`' finding already.
 */
const VALUE =
  /(?<![\w$.])((?:(?:globalThis|window|self)\s*\.\s*)?)fetch(?![\w$])(?!\s*(?:\?\.\s*)?\()/g;

/**
 * A destructured parameter binding `fetch` — `({ fetch }) =>`, `function f({ fetch }: Deps) {` —
 * which `bindsFetch` does not read, and which is otherwise the very shorthand `rpc({ fetch })`.
 */
const DESTRUCTURED_PARAM =
  /\(\s*\{[^{}]*\bfetch\b[^{}]*\}\s*(?::[^()]*)?\)\s*(?::[^={;]+)?(?:=>|\{)/;

/** The last non-blank character before `index`, or `''`. */
function before(masked: string, index: number): string {
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = masked[at] ?? '';
    if (!/\s/.test(char)) return char;
  }
  return '';
}

/** Where the name sits is no value: a type, an object/interface key, an assignment target. */
function isNotAValue(masked: string, start: number, end: number): boolean {
  // `typeof fetch`, `typeof globalThis.fetch` — a type position (or a feature probe, no request).
  if (/\btypeof\s*$/.test(masked.slice(Math.max(0, start - 12), start))) return true;
  const after = masked.slice(end, end + 3);
  // `{ fetch: impl }`, `fetch?: Fn` — a key; `a ? fetch : b` is the ternary's value.
  if (/^\s*\??\s*:(?!:)/.test(after) && before(masked, start) !== '?') return true;
  // `window.fetch = wrapped`, `<C fetch={…}>` — the name is written to, not read.
  return /^\s*=(?![=>])/.test(after);
}

export function fetchValues(source: string): readonly TransportCall[] {
  if (!source.includes('fetch')) return [];
  // Comments and strings blanked, offsets kept: `'fetch'` in a message is not the global.
  const masked = maskLiterals(source);
  const lineAt = lineIndex(masked);
  const shadowed = bindsFetch(masked) || DESTRUCTURED_PARAM.test(masked);
  const values: TransportCall[] = [];
  for (const found of masked.matchAll(VALUE)) {
    const global = (found[1] ?? '').replace(/\s/g, '');
    if (global === '' && shadowed) continue;
    if (isNotAValue(masked, found.index, found.index + found[0].length)) continue;
    values.push({ shape: 'fetch', line: lineAt(found.index), spelled: `${global}fetch` });
  }
  return values;
}
