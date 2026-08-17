// Panel: DB.
// Kills: "what is actually in the table, and does it match the migrations?" — psql in a tab,
// read-only by default, plus the schema diff against the migration history.

import { isUltimateError } from '@ultimat3/core';
import { assertReadOnlyQuery } from '@ultimat3/mcp';
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

/**
 * Every span Postgres reads as opaque text rather than as SQL, in ONE alternation: a `'…'`
 * string (`''` escapes included), a `"…"` quoted identifier (`""` included), a `$tag$…$tag$`
 * dollar-quoted body, a `--` line comment and a slash-star block comment.
 *
 * One pass, not five. Sequential passes cannot be ordered correctly, because each form can
 * contain the opener of any other: blanking comments first eats the `--` inside `'…'`, and
 * blanking strings first eats the `'` inside a comment. A single left-to-right scan resolves
 * that the way a lexer does — whichever token *starts* first consumes the rest.
 *
 * This is NO LONGER a security scan and must not be read as one. It once fed a write-keyword
 * check in this file; that check is gone and `assertReadOnlyQuery` owns the question. All this
 * decides now is "did the developer type a statement, or only a comment".
 */
const OPAQUE_SPAN =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Blanks every comment and literal so `-- still typing` and `/* … *​/` read as an empty box
 * rather than as a refusal. Blanked to spaces, never deleted, so `whe`+`re` never fuses into a
 * new word.
 *
 * Says NOTHING about whether the statement is safe, and in particular nothing about an
 * unterminated delimiter: this regex simply fails to match one, which used to be described here
 * as failing closed. It was — for a keyword scan that no longer exists. `assertReadOnlyQuery` is
 * what refuses an unterminated delimiter now, in all five forms.
 */
function sanitize(sql: string): string {
  return sql.replace(OPAQUE_SPAN, (span) => ' '.repeat(span.length));
}

/**
 * Read-only is enforced here, not just in the UI: /_x runs with the developer's own DB
 * credentials, so "the textarea only sends SELECTs" would be the whole safety story.
 * `x db psql --write` is the deliberate way out.
 *
 * ONE implementation of "is this a read", and it is `@ultimat3/mcp`'s. That guard refuses four
 * things this file's own keyword scan never did — a batch of statements, a call into the
 * `pg_read_*`/`pg_advisory_*`/`pg_sleep`/`set_config` families (a prefix, so a member Postgres adds
 * next release is refused on the day it ships), `FOR UPDATE`, and a delimiter that never closes in
 * any of its five forms (`'`, `E'`, `"`, `$tag$`, slash-star) — and a second, weaker copy of a
 * security rule is how the two drift apart. Downward, not sideways: `admin` is tier 5, `mcp` is
 * tier 4, and `@ultimat3/mcp` is already a dependency of this package (`src/mcp.ts`).
 *
 * NOTHING about the verdict stays local, deliberately. A local unterminated-delimiter refusal
 * lived here for one revision and was deleted: it tested for a surviving `'` or `"`, so it caught
 * three of the five forms and let `select $tag$ ; delete from members` fall through to the shared
 * guard — one failure mode with two different explanations, the local one calling a dollar-quoted
 * body "a quote". A second detector for a property the guard below already owns and tests is the
 * drift this delegation exists to remove.
 *
 * What stays local is the emptiness test and the WAY OUT: `@ultimat3/mcp` tells its caller to
 * expose an action, which is not advice a developer standing at `/_x` can act on. Only this file
 * knows which reader it is talking to.
 */
export function assertReadOnly(sql: string): string | null {
  // Nothing to run — a blank box or a comment the developer is still writing, not a refusal.
  if (sanitize(sql).trim() === '') return null;
  try {
    assertReadOnlyQuery(sql);
    return null;
  } catch (error) {
    // Structurally, never `String(error)`: the guard throws an `UltimateError` whose `cause` is
    // the sentence a developer needs, and anything else here is a bug in the guard, not a verdict.
    if (!isUltimateError(error)) throw error;
    // Two classes arrive through one code, and the panel cannot tell them apart without reading
    // another package's prose — so the way out is phrased to be true for both. It used to assert
    // `Run it with: x db psql --write`, which is the wrong instruction for a missing quote: that
    // flag grants writes, it does not close a delimiter.
    return `refused: ${error.cause}. Fix the statement, or — if it is meant to write — run it with: x db psql --write`;
  }
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
