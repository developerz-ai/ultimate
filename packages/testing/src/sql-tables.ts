// The tables one SQL statement reads or writes, read without a parser: each name after `from`,
// `join`, `update`, `into` or `using`, and each further name of a comma list there (`from orgs o,
// posts p`). Schema-qualified and double-quoted names answer their last part, lowercased.

const CLAUSE = /\b(?:from|join|update|into|using)\s+/gi;
const NAME = /(?:"([^"]+)"|(\w+))(?:\.(?:"([^"]+)"|(\w+)))?/y;
/** An alias, `as p` or bare `p` — never the keyword that ends the list. */
const ALIAS =
  /\s+(?:as\s+)?(?!(?:where|on|set|join|inner|left|right|full|cross|natural|group|order|limit|offset|returning|values|using|union|except|intersect|having|window|for|select|default|lateral|do|when|then)\b)\w+/iy;
const COMMA = /\s*,\s*/y;

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
      at = NAME.lastIndex;
      ALIAS.lastIndex = at;
      if (ALIAS.exec(statement) !== null) at = ALIAS.lastIndex;
      COMMA.lastIndex = at;
      if (COMMA.exec(statement) === null) break;
      at = COMMA.lastIndex;
    }
  }
  return tables;
}
