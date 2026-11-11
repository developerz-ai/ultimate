// Single responsibility: which statements in a migration's `up` half `x db gen` could never have
// written — the SQL a squash discards in silence. `REPLICA IDENTITY FULL`, `CREATE EXTENSION`, a
// `GRANT`, a data backfill: none of them is a declaration, none reaches a `.snapshot.json`, and no
// declaration-based drift check can see them, because a regenerated sidecar equals the declaration
// by construction. The rail is the same shape `destructive.ts` is — statements in, statements out.

import { PARTITION_FUNCTION } from './generate-partition';
import { ROW_SECURITY_POLICY } from './row-security';
import { stripSqlNoise } from './sql-noise';
import { statementExcerpt } from './statement-excerpt';
import { statementsOf } from './statement-split';

/** One statement form `generateMigration` emits, matched on its leading verb phrase. */
export interface GeneratableForm {
  /** What the form is called in a failing test's output. */
  readonly name: string;
  /** Anchored at the statement's start, against blanked and lowercased text. */
  readonly pattern: RegExp;
  /**
   * The name the statement's FIRST quoted identifier must be, read off the original text. Blanking
   * erases every identifier, so a hand-written `select "backfill"('a', 'b', 'c', 2, null)` has the
   * partition call's exact shape; only the generator's own name tells the two apart.
   */
  readonly identifier?: string;
}

/**
 * Everything this package's generator can emit, and nothing else.
 *
 * **The list is not a hand-typed opinion, and `ungeneratable.test.ts` is what keeps it from
 * becoming one.** Two assertions, in both directions, over a corpus that is the real output of
 * `generateMigration`: no statement in that corpus may be reported (or the check fires on the
 * framework's own migrations), and every entry here must match a statement in it (or the list has
 * grown an entry excusing SQL the generator never writes — which is the exact thing this rail
 * exists to report). A statement form added to `generate.ts` and not to this list fails the first;
 * an entry added here to silence a finding fails the second.
 *
 * Matched on the leading **verb phrase**, never on the whole statement: `alter table` is four
 * different operations and only some of them are generated, so the sub-clause is part of the
 * phrase — `alter table … replica identity full` shares its first two words with `add column` and
 * is the statement that started this.
 *
 * What it deliberately does not do is judge a statement's *body*. A hand-written `create table …
 * partition by range (…)` reads as generatable, because its verb phrase is one the generator
 * writes. Reporting that needs a schema comparison, which is `schema-drift`'s question and already
 * has an answer; this one is only ever about a statement with no declaration behind it at all.
 */
export const GENERATABLE_FORMS: readonly GeneratableForm[] = [
  { name: 'create table', pattern: /^create\s+table\b/ },
  { name: 'drop table', pattern: /^drop\s+table\b/ },
  { name: 'create index', pattern: /^create\s+index\b/ },
  { name: 'create unique index', pattern: /^create\s+unique\s+index\b/ },
  { name: 'drop index', pattern: /^drop\s+index\b/ },
  // `generate-view.ts` writes both kinds, and rebuilds by drop + create — never `or replace`, never
  // `refresh` — so those two stay hand-written and stay counted. A materialized view's indexes are
  // `create [unique] index`, already above.
  { name: 'create view', pattern: /^create\s+view\b/ },
  { name: 'create materialized view', pattern: /^create\s+materialized\s+view\b/ },
  { name: 'drop view', pattern: /^drop\s+view\b/ },
  { name: 'drop materialized view', pattern: /^drop\s+materialized\s+view\b/ },
  { name: 'add column', pattern: /^alter\s+table\s[\s\S]*?\badd\s+column\b/ },
  { name: 'drop column', pattern: /^alter\s+table\s[\s\S]*?\bdrop\s+column\b/ },
  { name: 'add constraint', pattern: /^alter\s+table\s[\s\S]*?\badd\s+constraint\b/ },
  { name: 'drop constraint', pattern: /^alter\s+table\s[\s\S]*?\bdrop\s+constraint\b/ },
  { name: 'validate constraint', pattern: /^alter\s+table\s[\s\S]*?\bvalidate\s+constraint\b/ },
  {
    name: 'alter column type',
    pattern: /^alter\s+table\s[\s\S]*?\balter\s+column\s[\s\S]*?\btype\b/,
  },
  {
    name: 'alter column set expression',
    pattern: /^alter\s+table\s[\s\S]*?\balter\s+column\s[\s\S]*?\bset\s+expression\b/,
  },
  {
    name: 'alter column drop expression',
    pattern: /^alter\s+table\s[\s\S]*?\balter\s+column\s[\s\S]*?\bdrop\s+expression\b/,
  },
  // `alterColumnInPlace` (`column-alter.ts`) writes all four — a moved default in both halves,
  // `drop not null` up with `set not null` down — and the list lacked them through 22.12.0, so
  // `x db gen` wrote migrations its own rail asked a `-- ungeneratable:` header for.
  {
    name: 'alter column set/drop default',
    pattern: /^alter\s+table\s[\s\S]*?\balter\s+column\s[\s\S]*?\b(?:set|drop)\s+default\b/,
  },
  {
    name: 'alter column set/drop not null',
    pattern: /^alter\s+table\s[\s\S]*?\balter\s+column\s[\s\S]*?\b(?:set|drop)\s+not\s+null\b/,
  },
  // The form the doc block above calls "the statement that started this", finally on the list:
  // `GenerateOptions.replicaIdentityFull` emits it `As of 2026-08-26`, so without this entry the
  // rail reports SQL the generator itself just wrote. Covers `full` and `default` in one phrase —
  // the down side is as generated as the up side.
  {
    name: 'alter table … replica identity full/default',
    // `full` and `default` ONLY — the two modes `replicaIdentityPlan` emits. `using index` and
    // `nothing` are hand-written configuration no entity declares, and admitting them here would
    // read them as generatable and let a squash discard the replication setup in silence.
    pattern: /^alter\s+table\s[\s\S]*?\breplica\s+identity\s+(?:full|default)\b/,
  },
  // The lifecycle triggers (`generate-triggers.ts`, `generate-history.ts`, `generate-counter.ts`,
  // `generate-append-only.ts`), read on BLANKED text: every name is a quoted identifier (`""`) and
  // every body a dollar quote, so each pattern is the whole statement's shape. Absent until
  // 2026-11-06, so `x db gen` wrote 11 statements its own rail reported. An unquoted, hand-written
  // trigger or function, and an `update` that is not the recount, stay counted.
  {
    name: 'create or replace function … returns trigger',
    pattern:
      /^create\s+or\s+replace\s+function\s+""\s*\(\s*\)\s+returns\s+trigger\s+language\s+plpgsql\s+as\s*$/,
  },
  { name: 'create trigger', pattern: /^create\s+trigger\s+""\s+(?:before|after)\s/ },
  { name: 'drop trigger if exists', pattern: /^drop\s+trigger\s+if\s+exists\s+""\s+on\s+""$/ },
  // The recount's cross-tenant switch, transaction-local (`true`): a setting, never a write.
  {
    name: 'select set_config(…, true)',
    pattern: /^select\s+set_config\s*\(\s*''\s*,\s*''\s*,\s*true\s*\)$/,
  },
  // `entity({ partitionBy })` (`generate-partition.ts`): the retired signature's drop, the
  // maintenance function and the call that makes the first partitions. Absent until 31.3, so an app
  // declaring `partitionBy` had its own generated migration reported by its own `drift` step.
  {
    name: 'drop function if exists … (retired partition signature)',
    identifier: PARTITION_FUNCTION,
    pattern:
      /^drop\s+function\s+if\s+exists\s+""\s*\(\s*text\s*,\s*text\s*,\s*text\s*,\s*integer\s*,\s*bigint\s*,\s*timestamptz\s*\)$/,
  },
  {
    name: 'create or replace function … returns jsonb',
    identifier: PARTITION_FUNCTION,
    pattern:
      /^create\s+or\s+replace\s+function\s+""\s*\(\s*parent\s+text\s*,\s*kind\s+text\s*,[\s\S]*\)\s+returns\s+jsonb\s+language\s+plpgsql\s+as\s*$/,
  },
  {
    name: 'select … partitions',
    identifier: PARTITION_FUNCTION,
    pattern: /^select\s+""\s*\(\s*''\s*,\s*''\s*,\s*''\s*,\s*\d+\s*,\s*null\s*\)$/,
  },
  // `database.rowSecurity` (`row-security-plan.ts`): both halves. Absent until 31.3 as well.
  {
    name: 'alter table … enable/disable/force/no force row level security',
    pattern: /^alter\s+table\s+""\s+(?:enable|disable|force|no\s+force)\s+row\s+level\s+security$/,
  },
  {
    name: 'create policy',
    identifier: ROW_SECURITY_POLICY,
    pattern: /^create\s+policy\s+""\s+on\s+""\s+using\s*\(/,
  },
  {
    name: 'drop policy if exists',
    identifier: ROW_SECURITY_POLICY,
    pattern: /^drop\s+policy\s+if\s+exists\s+""\s+on\s+""$/,
  },
  {
    name: 'update … recount',
    pattern:
      /^update\s+""\s+p\s+set\s+""\s*=\s*\(\s*select\s+count\s*\(\s*\*\s*\)::integer\s+from\s+""\s+c\s+where\s/,
  },
];

/** The first `"…"` identifier after any leading comments, unescaped; `undefined` when none. */
const firstIdentifier = (statement: string): string | undefined => {
  const code = statement.replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)*/, '');
  const found = /"((?:[^"]|"")*)"/.exec(code)?.[1];
  return found?.replaceAll('""', '"');
};

/**
 * Every statement in `up` that a regenerated migration would not carry, in apply order, as the one
 * capped line an error prints — the statement, never a count, because the whole value is telling an
 * author *which* line a squash discards.
 *
 * Decided on blanked text and reported from the original, the rule `destructiveStatements` states:
 * `statementsOf` cuts on a `;` that is not inside a literal, an identifier, a dollar-quoted body or
 * a comment, and `stripSqlNoise` blanks all four before a verb is looked for — so
 * `-- create extension pg_trgm` is prose and `values ('grant select on posts')` is data. The
 * excerpt keeps its identifiers, because `create extension ""` names nothing an author can act on.
 *
 * Only `up`, exactly as the destructive rail: `down` is full of statements the generator does emit
 * and reversing it teaches nobody anything about what the committed file uniquely holds.
 */
export function ungeneratableStatements(up: string): readonly string[] {
  const found: string[] = [];
  for (const statement of statementsOf(up)) {
    const bare = stripSqlNoise(statement).trim().toLowerCase();
    const named = firstIdentifier(statement);
    const generated = (form: GeneratableForm): boolean =>
      form.pattern.test(bare) && (form.identifier === undefined || form.identifier === named);
    if (GENERATABLE_FORMS.some(generated)) continue;
    found.push(statementExcerpt(statement));
  }
  return found;
}
