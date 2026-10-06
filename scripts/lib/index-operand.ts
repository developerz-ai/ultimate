// Single responsibility: reading WHAT an `indexOf`/`findIndex` operand indexes — the initialiser a
// bare name was bound to, and the haystack the call is made on. `index-of-order.ts` needs both to
// decide whether a phantom `-1` is possible and whether a `toContain` proves it is not.

import { balancedClose } from './balanced-paren';

const FROM_INDEX = /\b(?:indexOf|findIndex)\s*\(/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const escaped = (text: string): string => text.replace(/[$]/g, '\\$');

/**
 * The end of the statement starting at `from`: its `;` at depth 0. Parenthesised runs are jumped
 * whole by `balancedClose`, so a `;` inside a needle — `up.indexOf('a;b')` — or across a wrapped
 * `findIndex(\n (step) => …,\n)` never ends it early. Biome writes the semicolon every time.
 */
function statementEnd(body: string, from: number): number {
  for (let index = from; index < body.length; index += 1) {
    const char = body[index];
    if (char === '(') {
      const close = balancedClose(body, index);
      if (close < 0) return -1;
      index = close;
    } else if (char === ';') {
      return index;
    }
  }
  return -1;
}

/**
 * The `indexOf`/`findIndex` expression `name` was bound to in `body` — `const drop = up.indexOf(…);`
 * — or `undefined` when it is not a bare name, is not bound in `body`, or is bound to something
 * else. `body` is ONE test's text, so a name bound in a sibling test never resolves here.
 */
export function boundIndexInitialiser(body: string, name: string): string | undefined {
  if (!IDENTIFIER.test(name)) return undefined;
  const binding = new RegExp(
    `(?:^|[^\\w$.])(?:const|let|var)\\s+${escaped(name)}\\s*(?::[^=;]+?)?=(?!=)\\s*`,
  ).exec(body);
  if (binding === null) return undefined;
  const start = binding.index + binding[0].length;
  const end = statementEnd(body, start);
  if (end < 0) return undefined;
  const initialiser = body.slice(start, end).trim();
  return FROM_INDEX.test(initialiser) ? initialiser : undefined;
}

/**
 * The haystack `operand` indexes — `up` for `up.indexOf('x')`, `wiki` for `wiki.findIndex(…)` — or
 * `undefined` for a call with no receiver. Whitespace-normalised, so `expect(\n  up,\n)` compares.
 */
export function indexReceiver(operand: string): string | undefined {
  const call = /\.\s*(?:indexOf|findIndex)\s*\(/.exec(operand);
  if (call === null) return undefined;
  const receiver = operand.slice(0, call.index).replace(/\s+/g, ' ').trim();
  return receiver === '' ? undefined : receiver;
}
