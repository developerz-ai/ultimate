// Panel: DB.
// Kills: "what is actually in the table, and does it match the migrations?" — psql in a tab,
// read-only by default, plus the schema diff against the migration history.

import type { DriftFact, SqlResult, TableFact } from './facts';
import type { DevPanel } from './panel';

export interface DbPanelData {
  readonly tables: readonly TableFact[];
  readonly drift: readonly DriftFact[];
  readonly sql: string | null;
  readonly result: SqlResult | null;
  /** Set when a statement was refused; the panel shows it instead of a result grid. */
  readonly refused: string | null;
  readonly readOnly: boolean;
}

const WRITE_STATEMENT =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum)\b/i;

/** A `'...'` string literal, `''` escapes included — blanked before the keyword scan runs. */
const STRING_LITERAL = /'(?:[^']|'')*'/g;
const LINE_COMMENT = /--[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Strips what the keyword scan must not read as SQL: string content and both comment forms.
 * Order matters — string literals are blanked first, so a `--` or `/*` sitting inside one
 * (`where note = '-- not a comment'`) is never mistaken for the start of a real comment, and a
 * `create`/`update`/… sitting inside one (`where kind = 'create'`) never reaches the write-word
 * check below. Blanked to spaces, never deleted, so `whe`+`re` never fuses into a new keyword.
 */
function sanitize(sql: string): string {
  return sql
    .replace(STRING_LITERAL, (literal) => ' '.repeat(literal.length))
    .replace(BLOCK_COMMENT, (comment) => ' '.repeat(comment.length))
    .replace(LINE_COMMENT, (comment) => ' '.repeat(comment.length));
}

/**
 * Read-only is enforced here, not just in the UI: /_x runs with the developer's own DB
 * credentials, so "the textarea only sends SELECTs" would be the whole safety story.
 * `x db psql --write` is the deliberate way out.
 */
export function assertReadOnly(sql: string): string | null {
  const stripped = sanitize(sql).trim();
  if (stripped === '') return null;
  if (WRITE_STATEMENT.test(stripped)) {
    return `refused: the /_x DB panel is read-only. Run it with: x db psql --write`;
  }
  if (!/^(select|with|explain|show|table)\b/i.test(stripped)) {
    return 'refused: only SELECT / WITH / EXPLAIN / SHOW / TABLE statements run here';
  }
  return null;
}

export const dbPanel: DevPanel<DbPanelData> = {
  key: 'db',
  titleKey: 'dev.panel.db.title',
  questionKey: 'dev.panel.db.question',
  async data(sources, params): Promise<DbPanelData> {
    const [tables, drift] = await Promise.all([sources.tables(), sources.drift()]);
    const sql = params.get('sql');
    if (sql === null || sql.trim() === '') {
      return { tables, drift, sql: null, result: null, refused: null, readOnly: true };
    }

    const refused = assertReadOnly(sql);
    return {
      tables,
      drift,
      sql,
      result: refused === null ? await sources.runSql(sql) : null,
      refused,
      readOnly: true,
    };
  },
};
