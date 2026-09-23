// The four ways browser code opens its own connection, found in ONE file's text: a `fetch(` CALL,
// `new WebSocket(`, `new XMLHttpRequest(`, `new EventSource(`. Pure, so every false positive the
// rule has to leave alone is a fixture string. Which file may hold which shape is the caller's.

import { maskLiterals } from '@ultimat3/core';
import { balancedClose } from './balanced-paren';
import { lineOf } from './source-scan';

export type TransportShape = 'fetch' | 'websocket' | 'xhr' | 'eventsource';

export interface TransportCall {
  readonly shape: TransportShape;
  readonly line: number;
  /** What the source spells — `fetch`, `globalThis.fetch`, `WebSocket` — so a finding quotes it. */
  readonly spelled: string;
}

const CONSTRUCTED: ReadonlyMap<string, TransportShape> = new Map([
  ['WebSocket', 'websocket'],
  ['XMLHttpRequest', 'xhr'],
  ['EventSource', 'eventsource'],
]);

/** The global object's three spellings. `server.fetch(` is a method, never the global. */
const GLOBAL = String.raw`(?:(?:globalThis|window|self)\s*\.\s*)`;
const NEW = new RegExp(
  String.raw`\bnew\s+${GLOBAL}?(WebSocket|XMLHttpRequest|EventSource)\s*\(`,
  'g',
);
const FETCH = new RegExp(String.raw`(?<![\w$.])(${GLOBAL}?)fetch\s*\(`, 'g');

/**
 * Whether the file binds `fetch` itself — a `const`/`let`/`var`/`function`, an import, a
 * destructured declaration or a parameter — which makes a BARE `fetch(` its own function, not the
 * page's. `packages/action/src/idempotency-postgres.ts` calls a local `fetch(key)`. Per file, not
 * per scope: a floor, and the one direction it errs is silence on a file that shadows the global
 * AND calls it bare. `globalThis.fetch(` is reported regardless.
 */
export function bindsFetch(code: string): boolean {
  return (
    /\b(?:const|let|var|function)\s+fetch\b/.test(code) ||
    /\bimport\s+[^;]*\bfetch\b[^;]*\bfrom\b/.test(code) ||
    /\b(?:const|let|var)\s*\{[^}]*\bfetch\b[^}]*\}\s*=/.test(code) ||
    /\(\s*(?:[\w$]+\s*(?::[^,()]+)?,\s*)*fetch\s*[?:,)=][^()]*\)\s*(?::[^={;]+)?(?:=>|\{)/.test(
      code,
    )
  );
}

/** `fetch(req) {` and `fetch(req): Promise<Response> {` define a method; they call nothing. */
function isDefinition(masked: string, open: number, start: number): boolean {
  if (/\b(?:function|async|get|set)\s*$/.test(masked.slice(Math.max(0, start - 16), start))) {
    return true;
  }
  const close = balancedClose(masked, open);
  if (close < 0) return false;
  const after = masked.slice(close + 1).trimStart();
  return after.startsWith('{') || (after.startsWith(':') && !after.startsWith('::'));
}

export function transportCalls(source: string): readonly TransportCall[] {
  // Comments AND string contents blanked, offsets kept: `'fetch('` in a message is not a call, and
  // neither is the one a template-literal scaffold emits for somebody else's file.
  const masked = maskLiterals(source);
  const calls: TransportCall[] = [];
  for (const found of masked.matchAll(NEW)) {
    const name = found[1] ?? '';
    const shape = CONSTRUCTED.get(name);
    if (shape !== undefined)
      calls.push({ shape, line: lineOf(masked, found.index), spelled: name });
  }
  const local = bindsFetch(masked);
  for (const found of masked.matchAll(FETCH)) {
    const qualified = (found[1] ?? '').length > 0;
    if (!qualified && local) continue;
    const open = found.index + found[0].length - 1;
    if (!qualified && isDefinition(masked, open, found.index)) continue;
    calls.push({
      shape: 'fetch',
      line: lineOf(masked, found.index),
      spelled: qualified ? `${(found[1] ?? '').replace(/\s/g, '')}fetch` : 'fetch',
    });
  }
  return calls.sort((a, b) => a.line - b.line);
}
