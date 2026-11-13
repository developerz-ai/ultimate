// The tables one SQL statement reads or writes, read without a parser: each name after `from`,
// `join`, `update`, `into` or `using`, and each further name of a comma list there (`from orgs o,
// posts p`). Schema-qualified and double-quoted names answer their last part, lowercased.

// Whitespace, `as` and the comma are scanned by index, so no regex here can backtrack
// (CodeQL js/polynomial-redos).

const CLAUSE = /\b(?:from|join|update|into|using)\s+/gi;
const NAME = /(?:"([^"]+)"|(\w+))(?:\.(?:"([^"]+)"|(\w+)))?/y;
const WORD = /\w+/y;
const SPACE = /\s/;
/** The words that end a list: never read as an alias. */
const NOT_ALIAS = new Set(
  'where on set join inner left right full cross natural group order limit offset returning values using union except intersect having window for select default lateral do when then'.split(
    ' ',
  ),
);

function skipSpace(s: string, i: number): number {
  let at = i;
  while (at < s.length && SPACE.test(s.charAt(at))) at++;
  return at;
}

/** The `\w+` at `at`, or null. */
function wordAt(s: string, at: number): string | null {
  WORD.lastIndex = at;
  return WORD.exec(s)?.[0] ?? null;
}

/** Past an alias — `as p` or bare `p` — after whitespace at `at`; `at` itself when there is none. */
function skipAlias(s: string, at: number): number {
  const start = skipSpace(s, at);
  if (start === at) return at;
  const word = wordAt(s, start);
  if (word === null) return at;
  if (word.toLowerCase() === 'as') {
    const next = skipSpace(s, start + 2);
    const alias = next > start + 2 ? wordAt(s, next) : null;
    if (alias !== null && !NOT_ALIAS.has(alias.toLowerCase())) return next + alias.length;
  }
  return NOT_ALIAS.has(word.toLowerCase()) ? at : start + word.length;
}

/** Every table `statement` names in a table position, in order, repeats kept. */
export function statementTables(statement: string): readonly string[] {
  const tables: string[] = [];
  for (const clause of statement.matchAll(CLAUSE)) {
    let at = clause.index + clause[0].length;
    for (;;) {
      NAME.lastIndex = at;
      const name = NAME.exec(statement);
      if (name === null) break;
      tables.push((name[3] ?? name[4] ?? name[1] ?? name[2] ?? '').toLowerCase());
      at = skipSpace(statement, skipAlias(statement, NAME.lastIndex));
      if (statement.charAt(at) !== ',') break;
      at = skipSpace(statement, at + 1);
    }
  }
  return tables;
}
