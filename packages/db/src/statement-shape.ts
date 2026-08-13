// Single responsibility: what shape a statement is — the verb it opens with, whether that verb
// writes, and the identity repeated statements are counted under. Two detectors above this package
// group statements by that identity (`x dev`'s ledger, the `statements` test fixture) and a third
// names spans from the same verb, so the rule lives once, next to the `StatementEvent` it reads.
// Nothing here counts anything: a threshold is a verdict's, and a verdict is `@ultimat3/entity`'s.

import type { StatementEvent } from './observe';

const LEADING_WORD = /^[A-Za-z]+/;
const WHITESPACE = /\s+/g;

/**
 * The first word, lowercased — `select`, `insert`, `begin` — and `''` when a statement opens with
 * anything else. A text opening with a comment or a parenthesis has no verb, deliberately: this is
 * the one word every statement carries, and stripping comments to find a later one would be a
 * second SQL scanner living next to `inspectStatement` for the sake of one label.
 */
export function statementVerb(text: string): string {
  return (LEADING_WORD.exec(text.trimStart())?.[0] ?? '').toLowerCase();
}

/**
 * The verbs that make a statement a write. A set of verbs and not a set of repository operations:
 * a soft delete is an `update`, an op list would drift with `@ultimat3/entity`'s method names, and
 * hand-written SQL carries no operation at all.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'upsert',
  'merge',
  'truncate',
  'copy',
]);

/**
 * Read or write, decided from the statement rather than from the operation above it, for the same
 * reason `statementSpanName` reads the verb: it is the one fact every statement carries, attributed
 * or not. A statement opening with a CTE reads as a read — naming `insertAll` in a fix for a loop
 * of `with … select` would be wrong more often than naming `preload` for a loop that writes.
 */
export function statementKind(text: string): 'read' | 'write' {
  return WRITE_VERBS.has(statementVerb(text)) ? 'write' : 'read';
}

/**
 * The identity a loop repeats. An attributed statement groups by `entity.op`, because
 * `members.findById` fifty times is the report an author can act on and the SQL is one sample of
 * it — which is the whole reason `withStatementAttribution` exists. Everything else groups by its
 * own text, already `$n`-parameterized by `sql()`, with whitespace collapsed so a builder that
 * indents differently between two calls is still one shape rather than two.
 */
export function statementFingerprint(event: StatementEvent): string {
  const attribution = event.attribution;
  if (attribution !== undefined) return `${attribution.entity}.${attribution.op}`;
  return event.text.replace(WHITESPACE, ' ').trim();
}
