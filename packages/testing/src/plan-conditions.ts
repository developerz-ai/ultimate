// A plan node's conditions, read as the columns one scanned table compares: by equality, by any
// other way, and per arm of an OR. An OR is served by one index per arm (a BitmapOr), never by one
// index over every column it names, so its arms are kept apart from the conjuncts around it.

/** The scan whose columns are read: its table and the alias the plan qualifies it by. */
export interface ConditionScan {
  readonly table: string | undefined;
  readonly alias: string | undefined;
}

export interface ConditionColumns {
  readonly equality: string[];
  readonly range: string[];
  /** The first OR whose every arm compares a column of the table: each arm's columns. */
  readonly arms?: readonly (readonly string[])[];
}

const IDENT = /(?:"?([A-Za-z_][\w$]*)"?\.)?"?([A-Za-z_][\w$]*)"?/g;
const EQUALITY = /(?<![<>!])=(?!>)/;
/** `IS NULL` pins one value as `=` does, and a btree serves it as an index condition. */
const IS_NULL = /\bIS\s+NULL\b/i;

/** The parts of `text` between `word`s that stand outside every parenthesis and literal. */
function splitTop(text: string, word: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(` ${word} `, at)) {
      parts.push(text.slice(start, at));
      start = at + word.length + 2;
      at = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(unwrap);
}

/** `((a = $1))` → `a = $1`: parentheses that wrap the whole text, and only those. */
function unwrap(text: string): string {
  let rest = text.trim();
  for (;;) {
    if (!rest.startsWith('(') || !rest.endsWith(')')) return rest;
    let depth = 0;
    for (let at = 0; at < rest.length; at += 1) {
      if (rest[at] === '(') depth += 1;
      else if (rest[at] === ')') depth -= 1;
      if (depth === 0 && at < rest.length - 1) return rest;
    }
    rest = rest.slice(1, -1).trim();
  }
}

/** The columns of the table a conjunct names; a name qualified by another alias is not its. */
function namesIn(conjunct: string, scan: ConditionScan, columns: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const [, qualifier, name] of conjunct.replace(/'[^']*'/g, '').matchAll(IDENT)) {
    if (name === undefined || !columns.has(name)) continue;
    if (qualifier !== undefined && qualifier !== scan.alias && qualifier !== scan.table) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The columns of `scan` the conditions name, split by how they are compared: `=` and `IS NULL`
 * are equality, anything else a range. A conjunct qualified by another alias is a join's other
 * side; an unqualified name counts when the table has the column. An OR is no conjunct of either.
 */
export function columnsIn(
  conditions: readonly string[],
  scan: ConditionScan,
  columns: ReadonlySet<string>,
): ConditionColumns {
  const equality: string[] = [];
  const range: string[] = [];
  let arms: string[][] | undefined;
  for (const condition of conditions) {
    for (const conjunct of splitTop(unwrap(condition), 'AND')) {
      const alternatives = splitTop(conjunct, 'OR');
      if (alternatives.length > 1) {
        const each = alternatives.map((arm) => {
          const found = columnsIn([arm], scan, columns);
          return [...found.equality, ...found.range];
        });
        if (arms === undefined && each.every((arm) => arm.length > 0)) arms = each;
        continue;
      }
      const into = EQUALITY.test(conjunct) || IS_NULL.test(conjunct) ? equality : range;
      for (const name of namesIn(conjunct, scan, columns)) {
        if (!equality.includes(name) && !range.includes(name)) into.push(name);
      }
    }
  }
  return {
    equality,
    range: range.filter((name) => !equality.includes(name)),
    ...(arms === undefined ? {} : { arms }),
  };
}
