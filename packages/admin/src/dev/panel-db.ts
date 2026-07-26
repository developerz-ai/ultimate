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
 * Read-only is enforced here, not just in the UI: /_x runs with the developer's own DB
 * credentials, so "the textarea only sends SELECTs" would be the whole safety story.
 * `x db psql --write` is the deliberate way out.
 */
export function assertReadOnly(sql: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, ' ').trim();
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
  titleKey: 'dev.panel.db',
  question: 'what is in the table, and does the schema match the migrations?',
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
