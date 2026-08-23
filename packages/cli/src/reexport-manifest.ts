// Whether a file is a pure re-export manifest — every statement in it an `import` or an `export`
// that declares nothing. The line ceiling is a rule about REVIEWABLE LOGIC, and such a file has
// none: its length is a function of the package's API size, so the ceiling measures the wrong
// thing there. One added statement of logic disqualifies it and re-arms the ceiling on the spot.

import { CLOSERS, maskLiterals, OPENERS } from './ts-scan';

/** Every statement a manifest may hold begins with one of these two words. */
const IMPORT_OR_EXPORT = /^(?:import|export)\b/;

/**
 * An `export` that DECLARES rather than re-exports. `export const LIMIT = 1` is a value with an
 * initialiser, `export function` is logic outright, and both are exactly what the ceiling is for —
 * so a file holding one is an ordinary source file that happens to start with re-exports.
 */
const DECLARES =
  /^export\s+(?:default|declare|abstract|async|const|let|var|function|class|enum|namespace|module|interface)\b/;

/**
 * `export type { Ctx } from './ctx'` is a re-export; `export type Ctx = { … }` is a type alias, and
 * an alias is a declaration a reviewer reads. The brace is the whole distinction.
 */
const TYPE_ALIAS = /^export\s+type\s+[A-Za-z_$]/;

/**
 * Top-level statements, split at the `;` that ends each one at bracket depth 0, over MASKED source
 * — comments and string contents blanked — so a `;` inside a specifier or a comment is not read as
 * a boundary. `undefined` when the file ends in something this cannot read as a statement: a scan
 * that guesses would exempt a file on the strength of not understanding it.
 */
function topLevelStatements(masked: string): readonly string[] | undefined {
  const statements: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    // Clamped, because an unbalanced closer would otherwise put every later `;` at a negative
    // depth and the whole file would read as one unterminated statement.
    else if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      statements.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  return masked.slice(start).trim() === '' ? statements : undefined;
}

/**
 * True when every statement in `source` is an import or a declaration-free export. A file with no
 * statement at all is NOT a manifest: an exemption has to be earned by what a file holds, and
 * "this scan found nothing" is the one answer that must never grant one.
 */
export function isReExportManifest(source: string): boolean {
  const statements = topLevelStatements(maskLiterals(source));
  if (statements === undefined || statements.length === 0) return false;
  return statements.every((statement) => {
    const text = statement.trim();
    if (text === '') return true;
    return IMPORT_OR_EXPORT.test(text) && !DECLARES.test(text) && !TYPE_ALIAS.test(text);
  });
}
