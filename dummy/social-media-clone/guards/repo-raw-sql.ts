// repo-raw-sql: a repo.ts reads through the typed handle, so tenancy and the codecs ride on every statement.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Only a statement the handle can express is reported: `select *`, `insert`, `update` or `delete`
// on ONE table, with plain comparisons. A join, an aggregate, a CTE, a window, an `or`, a function
// call and a statement composed from another fragment are past what the handle says, and silent.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_REPO_RAW_SQL';

export interface RepoFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** One tagged template: its text with every interpolation reduced to `?`, and where it starts. */
export interface Statement {
  readonly text: string;
  readonly line: number;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Past the closing quote of the string opening at `open`. */
const endOfString = (source: string, open: number): number => {
  let index = open + 1;
  while (index < source.length && source[index] !== source[open]) {
    index += source[index] === '\\' ? 2 : 1;
  }
  return index + 1;
};

/** Past the `}` of the interpolation whose body starts at `from`; strings and templates skip whole. */
const endOfInterpolation = (source: string, from: number): number => {
  let depth = 1;
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === '`') index = readTemplate(source, index).end;
    else if (char === "'" || char === '"') index = endOfString(source, index);
    else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
      if (depth === 0) return index;
    }
  }
  return index;
};

/**
 * The template literal opening at `open`. An interpolation is a bound parameter, so it reads `?` —
 * unless it holds another `sql` literal, which is a statement being COMPOSED: the handle has no
 * word for that, and the marker makes sure no rule below matches it.
 */
function readTemplate(
  source: string,
  open: number,
): { readonly text: string; readonly end: number } {
  let text = '';
  let index = open + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '`') return { text, end: index + 1 };
    if (char === '\\') {
      text += source.slice(index, index + 2);
      index += 2;
    } else if (char === '$' && source[index + 1] === '{') {
      const end = endOfInterpolation(source, index + 2);
      text += /\bsql`/.test(source.slice(index, end)) ? ' <fragment> ' : '?';
      index = end;
    } else {
      text += char;
      index += 1;
    }
  }
  return { text, end: index };
}

/**
 * Every `sql` tagged template in real code. A scanner rather than a regex, because the lookalikes
 * are the common case: this file's own header says "a query's `sql`" in a COMMENT, and a string
 * may hold a backtick. Both are walked past, never read.
 */
export function sqlStatements(source: string): readonly Statement[] {
  const found: Statement[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (pair === '//') {
      const eol = source.indexOf('\n', index);
      index = eol === -1 ? source.length : eol;
    } else if (pair === '/*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
    } else if (char === "'" || char === '"') {
      index = endOfString(source, index);
    } else if (char === '`') {
      const template = readTemplate(source, index);
      if (/(?:^|[^\w$])sql$/.test(source.slice(Math.max(0, index - 4), index))) {
        found.push({ text: template.text, line: lineOf(source, index) });
      }
      index = template.end;
    } else index += 1;
  }
  return found;
}

const NAME = '[a-z_][a-z0-9_]*';
const TABLE = `"?(${NAME})"?`;
const VALUE = "(?:\\?|-?\\d+(?:\\.\\d+)?|'[^']*'|null|true|false)";
const COMPARISON = `"?${NAME}"? (?:(?:=|<>|!=|<=|>=|<|>|like|in) ${VALUE}|is (?:not )?null)`;
const WHERE = `(${COMPARISON}(?: and ${COMPARISON})*)`;
const ORDER = `"?(${NAME})"?(?: (asc|desc))?(?:, ?"?${NAME}"?(?: (?:asc|desc))?)*`;
const ASSIGNMENT = `"?${NAME}"? = ${VALUE}`;

const SELECT = new RegExp(
  `^select \\* from ${TABLE}(?: where ${WHERE})?(?: order by ${ORDER})?(?: limit (${VALUE}))?$`,
);
const INSERT = new RegExp(
  `^insert into ${TABLE} \\([^()]*\\) values \\(${VALUE}(?:, ?${VALUE})*\\)(?: returning \\*)?$`,
);
const UPDATE = new RegExp(
  `^update ${TABLE} set ${ASSIGNMENT}(?:, ?${ASSIGNMENT})* where ${WHERE}(?: returning \\*)?$`,
);
const DELETE = new RegExp(`^delete from ${TABLE} where ${WHERE}(?: returning \\*)?$`);

/** `short_links` → `shortLinks`: the handle is keyed by the camelCase the entity declares. */
const camel = (name: string): string =>
  name.replaceAll(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

const OPERATORS: Readonly<Record<string, string>> = {
  '<>': 'neq',
  '!=': 'neq',
  '<': 'lt',
  '<=': 'lte',
  '>': 'gt',
  '>=': 'gte',
  like: 'like',
  in: 'in',
};

/** The predicate as the handle spells it: equalities in one `where({ … })`, the rest chained. */
const filterCalls = (where: string | undefined): string => {
  if (where === undefined) return '';
  const equal: string[] = [];
  const others: string[] = [];
  for (const comparison of where.split(' and ')) {
    const [column = '', operator = '', ...rest] = comparison.replaceAll('"', '').split(' ');
    const name = camel(column);
    if (operator === '=') equal.push(name);
    else if (operator !== 'is') {
      others.push(`.andWhere('${name}', '${OPERATORS[operator] ?? operator}', value)`);
    } else others.push(`.andWhere('${name}', '${rest.length === 2 ? 'is-not-null' : 'is-null'}')`);
  }
  return `${equal.length === 0 ? '' : `.where({ ${equal.join(', ')} })`}${others.join('')}`;
};

/** Whether the predicate is exactly "this id" — the shape `update(id, …)` and `delete(id)` take. */
const byIdOnly = (where: string): boolean => /^"?id"? = \?$/.test(where);

/**
 * The handle call that says what `sql` says, or `undefined` when the handle cannot say it. `sql`
 * is the literal's text as written; whitespace, case and a trailing `;` are not part of the rule.
 */
export function handleCallFor(sql: string): string | undefined {
  const text = sql
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\( /g, '(')
    .replaceAll(/ \)/g, ')')
    .trim()
    .replace(/;$/, '')
    .trim();
  const select = SELECT.exec(text);
  if (select !== null) {
    const [, table = '', where, column, direction, limit] = select;
    const order =
      column === undefined
        ? ''
        : `.orderBy('${camel(column)}'${direction === 'desc' ? ", 'desc'" : ''})`;
    const one = column === undefined && limit === undefined && /(^| )"?id"? = /.test(where ?? '');
    const bound = limit === undefined ? '' : `.limit(${limit === '?' ? 'limit' : limit})`;
    return `db.${camel(table)}${filterCalls(where)}${order}${bound}.${one ? 'one' : 'all'}()`;
  }
  const insert = INSERT.exec(text);
  if (insert !== null) return `db.${camel(insert[1] ?? '')}.insert({ … })`;
  const update = UPDATE.exec(text);
  if (update !== null) {
    const [, table = '', where = ''] = update;
    return byIdOnly(where)
      ? `db.${camel(table)}.update(id, { … })`
      : `db.${camel(table)}.updateWhere({ … }, { … })`;
  }
  const remove = DELETE.exec(text);
  if (remove !== null) {
    const [, table = '', where = ''] = remove;
    return byIdOnly(where)
      ? `db.${camel(table)}.delete(id)`
      : `db.${camel(table)}.deleteWhere({ … })`;
  }
  return undefined;
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawRepoSql(files: readonly RepoFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const statement of sqlStatements(file.source)) {
      const call = handleCallFor(statement.text);
      if (call === undefined) continue;
      const at = `${file.path}:${statement.line}`;
      findings.push({
        code: CODE,
        cause: `${at} sends a statement the typed handle expresses as hand-written SQL — no tenant guard on it, no codec for money or a sealed column, and no compile error when a column is renamed`,
        fix: `${call} — in place of the sql literal at ${at}, with db imported from this app's db package, then: x verify`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a repo.ts reads through the typed handle, never a sql literal the handle can express',
  async check(_root, sources) {
    // The run's ONE read of these files: every guard asking for this glob shares the walk.
    const repos = await sources.files('{apps,packages}/**/repo.ts');
    return rawRepoSql(repos.map((file) => ({ path: file.path, source: file.text })));
  },
};
