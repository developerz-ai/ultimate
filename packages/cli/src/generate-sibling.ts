// Whether a feature's `entity.ts` makes the next `x g entity --feature` a SIBLING
// (`entity-<name>.ts`). Decided on what the file READABLY declares, and conservatively: the
// sibling path skips the conflict on `entity.ts`, so taking the same table for "another one" —
// because it is spelled as a template literal, or held in a constant — wrote a second module for
// one table where the run should have refused.

import { endOfLiteral, maskLiterals, QUOTES } from '@ultimat3/core';
import { names } from './templates/naming';

/** `entity(` as a call of the imported function — never a member (`schema.entity(`). */
const ENTITY_CALL = /(?<![.\w$])entity\(\s*/g;

/**
 * True only when `source` declares at least one entity, EVERY `entity(…)` call in it names its
 * table as a plain string literal, none of those tables is `name`'s, and no binding in the file
 * is `name`'s own. Anything this cannot read — a constant, an interpolation — answers false: the
 * run then takes the ordinary path, and an existing `entity.ts` is the conflict it always was.
 */
export function declaresOnlyOtherEntities(source: string, name: string): boolean {
  const masked = maskLiterals(source);
  const calls = [...masked.matchAll(ENTITY_CALL)];
  if (calls.length === 0) return false;
  const { table, camel } = names(name);
  // A camel spelling is `[A-Za-z0-9]` only (`naming.ts`), so it splices into a pattern as is.
  if (new RegExp(`\\b(?:const|let|var)\\s+${camel}\\b`).test(masked)) return false;
  return calls.every((call) => {
    const at = call.index + call[0].length;
    if (!QUOTES.has(masked[at] ?? '')) return false;
    const end = endOfLiteral(source, at);
    if (end === at + 1) return false;
    const value = source.slice(at + 1, end - 1);
    return !value.includes('${') && !value.includes('\\') && value !== table;
  });
}
