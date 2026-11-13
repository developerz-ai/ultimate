// repo-raw-sql: a repo.ts reads through the typed handle, so tenancy and the codecs ride on every statement.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Only a statement the handle can express is reported: `select *` or a plain column list (the fix
// projects it with `.select({ … })`), `insert`, `update` or `delete` on ONE table, with plain
// comparisons, and `select * … where id = ? for update`. A join, an aggregate, a CTE, a window, an `or`, a function
// call and a statement composed from another fragment are past what the handle says, and silent.
// Three more shapes are reported in any statement, join or not: an `order by date_trunc('milliseconds', …)`
// and a hand row comparison `(a, b) < (?, ?)`, whose repair is `keyset()` from `@ultimat3/db`, and a
// `pg_advisory_xact_lock(…)`, whose repair is the handle's `lockKeys`. A quoted literal is data, never shape.

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

/** `*`, or plain column names: an alias, a qualified name or an expression is past the handle. */
const COLUMNS = `(\\*|"?${NAME}"?(?:, ?"?${NAME}"?)*)`;

const SELECT = new RegExp(
  `^select ${COLUMNS} from ${TABLE}(?: where ${WHERE})?(?: order by ${ORDER})?(?: limit (${VALUE}))?$`,
);
const INSERT = new RegExp(
  `^insert into ${TABLE} \\([^()]*\\) values \\(${VALUE}(?:, ?${VALUE})*\\)(?: returning \\*)?$`,
);
const UPDATE = new RegExp(
  `^update ${TABLE} set ${ASSIGNMENT}(?:, ?${ASSIGNMENT})* where ${WHERE}(?: returning \\*)?$`,
);
const DELETE = new RegExp(`^delete from ${TABLE} where ${WHERE}(?: returning \\*)?$`);
/** One row by its id, locked: the read-modify-write `lock` exists for. Another lock mode is silent. */
const LOCKED = new RegExp(`^select \\* from ${TABLE} where ${WHERE}(?: limit 1)? for update$`);

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

/**
 * A quoted literal, and the value it splices as. Masked to `'<n>'` before the statement is
 * lowercased and split on spaces, so its case, its spaces and an `and` inside it survive.
 */
const LITERAL = /'(?:[^']|'')*'/g;

const jsString = (sqlLiteral: string): string => {
  const inner = sqlLiteral.slice(1, -1).replaceAll("''", "'");
  return /['\\]/.test(inner) ? JSON.stringify(inner) : `'${inner}'`;
};

/**
 * The predicate as the handle spells it: equalities in one `where({ … })`, the rest chained. A
 * literal is its value, never a binding: `.where({ status })` names a variable nobody declared.
 */
const filterCalls = (where: string | undefined, literals: readonly string[]): string => {
  if (where === undefined) return '';
  const spliced = (value: string): string | undefined => {
    if (value === '?') return undefined;
    const masked = /^'(\d+)'$/.exec(value);
    return masked === null ? value : jsString(literals[Number(masked[1])] ?? "''");
  };
  const equal: string[] = [];
  const others: string[] = [];
  for (const comparison of where.split(' and ')) {
    const [column = '', operator = '', value = '?'] = comparison.replaceAll('"', '').split(' ');
    const name = camel(column);
    const literal = spliced(value);
    if (operator === '=') equal.push(literal === undefined ? name : `${name}: ${literal}`);
    else if (operator !== 'is') {
      const op = Object.hasOwn(OPERATORS, operator) ? OPERATORS[operator] : operator;
      others.push(`.andWhere('${name}', '${op}', ${literal ?? 'value'})`);
    } else others.push(`.andWhere('${name}', '${value === 'not' ? 'is-not-null' : 'is-null'}')`);
  }
  return `${equal.length === 0 ? '' : `.where({ ${equal.join(', ')} })`}${others.join('')}`;
};

/** Whether the predicate is exactly "this id" — the shape `update(id, …)` and `delete(id)` take. */
const byIdOnly = (where: string): boolean => /^"?id"? = \?$/.test(where);

/**
 * Whether every comparison is an equality: all `updateWhere`/`deleteWhere` take. A range is the
 * chain's one-statement `updateAll`/`deleteAll` — naming the filter would drop the range.
 */
const equalitiesOnly = (where: string): boolean =>
  where.split(' and ').every((comparison) => / = /.test(comparison));

/** `id, created_at` → `.select({ id: true, createdAt: true })`; `*` is the whole row, no call. */
const projection = (columns: string): string =>
  columns === '*'
    ? ''
    : `.select({ ${columns
        .split(',')
        .map((column) => `${camel(column.trim().replaceAll('"', ''))}: true`)
        .join(', ')} })`;

/**
 * The handle call that says what `sql` says, or `undefined` when the handle cannot say it. `sql`
 * is the literal's text as written; whitespace, case and a trailing `;` are not part of the rule.
 */
export function handleCallFor(sql: string): string | undefined {
  const literals: string[] = [];
  const text = sql
    .replaceAll(LITERAL, (literal) => `'${literals.push(literal) - 1}'`)
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\( /g, '(')
    .replaceAll(/ \)/g, ')')
    .trim()
    .replace(/;$/, '')
    .trim();
  const locked = LOCKED.exec(text);
  if (locked !== null && /(^| )"?id"? = \?/.test(locked[2] ?? '')) {
    return `db.${camel(locked[1] ?? '')}.lock(id, fn)`;
  }
  const select = SELECT.exec(text);
  if (select !== null) {
    const [, columns = '*', table = '', where, column, direction, limit] = select;
    const order =
      column === undefined
        ? ''
        : `.orderBy('${camel(column)}'${direction === 'desc' ? ", 'desc'" : ''})`;
    const one = column === undefined && limit === undefined && /(^| )"?id"? = /.test(where ?? '');
    const bound = limit === undefined ? '' : `.limit(${limit === '?' ? 'limit' : limit})`;
    return `db.${camel(table)}${filterCalls(where, literals)}${order}${bound}${projection(columns)}.${one ? 'one' : 'all'}()`;
  }
  const insert = INSERT.exec(text);
  if (insert !== null) return `db.${camel(insert[1] ?? '')}.insert({ … })`;
  const update = UPDATE.exec(text);
  if (update !== null) {
    const [, table = '', where = ''] = update;
    if (byIdOnly(where)) return `db.${camel(table)}.update(id, { … })`;
    return equalitiesOnly(where)
      ? `db.${camel(table)}.updateWhere({ … }, { … })`
      : `db.${camel(table)}${filterCalls(where, literals)}.updateAll({ … })`;
  }
  const remove = DELETE.exec(text);
  if (remove !== null) {
    const [, table = '', where = ''] = remove;
    if (byIdOnly(where)) return `db.${camel(table)}.delete(id)`;
    return equalitiesOnly(where)
      ? `db.${camel(table)}.deleteWhere({ … })`
      : `db.${camel(table)}${filterCalls(where, literals)}.deleteAll()`;
  }
  return undefined;
}

/**
 * `order by date_trunc('milliseconds', col)`: the cure for a JS `Date` dropping microseconds, and
 * the plan's loss — an expression the index does not hold sorts every row. A line comment inside
 * the statement is not code, so it is dropped before the match.
 */
export function truncatedOrder(sql: string): boolean {
  const text = sql
    .replaceAll(/--[^\n]*/g, ' ')
    .toLowerCase()
    .replaceAll(/\s+/g, ' ');
  return /\border by [^;]*\bdate_trunc ?\( ?'milliseconds'/.test(text);
}

const KEYSET_CALL =
  "keyset({ scope, keys: [{ column: raw('p.created_at'), kind: 'timestamptz', direction: 'desc' }, { column: raw('p.id'), kind: 'uuid', direction: 'desc' }], after, limit })";

const truncatedFinding = (at: string): Finding => ({
  code: CODE,
  cause: `${at} orders by date_trunc('milliseconds', …), the workaround for a Date losing microseconds — and the index cannot serve that expression: measured on 300,000 rows, an Index Only Scan (0.2 ms) became a Parallel Seq Scan and a sort (100 ms)`,
  fix: `${KEYSET_CALL} — from @ultimat3/db, its select, where, orderBy and limit spliced in place of the date_trunc order at ${at}, then: x verify`,
  at,
});

/** Comments dropped and every quoted literal emptied: the words inside one are data, not shape. */
const shapeOf = (sql: string): string =>
  sql
    .replaceAll(/--[^\n]*/g, ' ')
    .replaceAll(LITERAL, "''")
    .toLowerCase()
    .replaceAll(/\s+/g, ' ');

const COLUMN = '"?[a-z_][a-z0-9_.]*"?';

/** `(created_at, id) < (?, ?)`: the seek of a keyset page, written by hand. */
const ROW_COMPARISON = new RegExp(`\\( ?${COLUMN}(?: ?, ?${COLUMN})+ ?\\) ?(?:<=|>=|<|>) ?\\(`);

export const rowComparison = (sql: string): boolean => ROW_COMPARISON.test(shapeOf(sql));

/** A transaction-scoped advisory lock taken by hand, under a key only this statement knows. */
export const advisoryLock = (sql: string): boolean =>
  /\bpg_advisory_xact_lock ?\(/.test(shapeOf(sql));

/** The shapes reported in ANY statement, join or not, each with the call that replaces it. */
const ANY_STATEMENT: readonly {
  readonly matches: (sql: string) => boolean;
  readonly finding: (at: string) => Finding;
}[] = [
  { matches: truncatedOrder, finding: (at) => truncatedFinding(at) },
  {
    matches: rowComparison,
    finding: (at) => ({
      code: CODE,
      cause: `${at} pages with a hand row comparison, (a, b) < (?, ?) — the seek keyset() writes with its tie-break, its direction and its cursor codec, each one a detail a hand copy gets wrong when a key column changes`,
      fix: `${KEYSET_CALL} — from @ultimat3/db, its keys the columns of the row comparison at ${at}, then: x verify`,
      at,
    }),
  },
  {
    matches: advisoryLock,
    finding: (at) => ({
      code: CODE,
      cause: `${at} takes pg_advisory_xact_lock by hand — a key hashed where nothing else can see it, and two keys taken in whatever order two callers reach them, which is a deadlock`,
      fix: `db.<table>.lockKeys([key], async (tx) => …) — the typed handle of the table the lock guards, sorted keys in one transaction, in place of the sql literal at ${at}, then: x verify`,
      at,
    }),
  },
];

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawRepoSql(files: readonly RepoFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const statement of sqlStatements(file.source)) {
      const shape = ANY_STATEMENT.find((one) => one.matches(statement.text));
      if (shape !== undefined) {
        findings.push(shape.finding(`${file.path}:${statement.line}`));
        continue;
      }
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
    // The run's ONE read of these files: every guard asking for this glob shares the walk. A
    // `repo-<part>.ts` is the same repo split at the file ceiling, so it is read too — but not a
    // `repo-<part>.test.ts`, which the same glob reaches and whose fixture SQL is no repo's.
    const repos = await sources.files('{apps,packages}/**/repo{,-*}.ts');
    const read = repos.filter((file) => !file.path.endsWith('.test.ts'));
    return rawRepoSql(read.map((file) => ({ path: file.path, source: file.text })));
  },
};
