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

/**
 * Every span Postgres reads as opaque text rather than as SQL, in ONE alternation: a `'…'`
 * string (`''` escapes included), a `"…"` quoted identifier (`""` included), a `$tag$…$tag$`
 * dollar-quoted body, a `--` line comment and a slash-star block comment.
 *
 * One pass, not five. Sequential passes cannot be ordered correctly, because each form can
 * contain the opener of any other: blanking comments first eats the `--` inside `'…'`, and
 * blanking strings first eats the `'` inside a comment. A single left-to-right scan resolves
 * that the way a lexer does — whichever token *starts* first consumes the rest — which is what
 * closes `SELECT 1 AS "--"; DELETE FROM members`, where the `--` hid inside an identifier and
 * commented the DELETE out of the guard's view while Postgres still ran it.
 */
const OPAQUE_SPAN =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Blanks what the keyword scan must not read as SQL, so a `create`/`update`/… sitting inside a
 * literal (`where kind = 'create'`) never reaches the write-word check below. Blanked to spaces,
 * never deleted, so `whe`+`re` never fuses into a new keyword. An *unterminated* quote matches
 * nothing and is left standing — the statement after it stays visible to the guard, and Postgres
 * rejects it as a syntax error anyway. Failing open there would be the bypass.
 */
function sanitize(sql: string): string {
  return sql.replace(OPAQUE_SPAN, (span) => ' '.repeat(span.length));
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
