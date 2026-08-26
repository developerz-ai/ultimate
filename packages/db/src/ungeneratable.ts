// Single responsibility: which statements in a migration's `up` half `x db gen` could never have
// written — the SQL a squash discards in silence. `REPLICA IDENTITY FULL`, `CREATE EXTENSION`, a
// `GRANT`, a data backfill: none of them is a declaration, none reaches a `.snapshot.json`, and no
// declaration-based drift check can see them, because a regenerated sidecar equals the declaration
// by construction. The rail is the same shape `destructive.ts` is — statements in, statements out.

import { stripSqlNoise } from './sql-noise';
import { statementExcerpt } from './statement-excerpt';
import { statementsOf } from './statement-split';

/** One statement form `generateMigration` emits, matched on its leading verb phrase. */
export interface GeneratableForm {
  /** What the form is called in a failing test's output. */
  readonly name: string;
  /** Anchored at the statement's start, against blanked and lowercased text. */
  readonly pattern: RegExp;
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
  { name: 'add column', pattern: /^alter\s+table\s[\s\S]*?\badd\s+column\b/ },
  { name: 'drop column', pattern: /^alter\s+table\s[\s\S]*?\bdrop\s+column\b/ },
  { name: 'add constraint', pattern: /^alter\s+table\s[\s\S]*?\badd\s+constraint\b/ },
  { name: 'drop constraint', pattern: /^alter\s+table\s[\s\S]*?\bdrop\s+constraint\b/ },
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
  // The form the doc block above calls "the statement that started this", finally on the list:
  // `GenerateOptions.replicaIdentityFull` emits it `As of 2026-08-26`, so without this entry the
  // rail reports SQL the generator itself just wrote. Covers `full` and `default` in one phrase —
  // the down side is as generated as the up side.
  {
    name: 'alter table … replica identity',
    pattern: /^alter\s+table\s[\s\S]*?\breplica\s+identity\b/,
  },
];

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
    if (GENERATABLE_FORMS.some((form) => form.pattern.test(bare))) continue;
    found.push(statementExcerpt(statement));
  }
  return found;
}
