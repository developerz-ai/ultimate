// Single responsibility: may THIS statement be served by a replica. An allow-list with a refusal
// list under it, whose default is the primary — the opposite bias to the `readonly.ts` lexer this
// package deleted, and the reason that deletion does not forbid this file.

import { statementVerb } from './statement-shape';

export type DbNode = 'primary' | 'replica';

/**
 * The only verbs a replica may be offered. `with` is here because a CTE read is the shape half the
 * framework's paginated queries take, and `WRITE_WORD` below is what tells `with … select` from
 * `with … update … returning` — which `statementKind()` calls a read, and is exactly why that
 * function is not the authority here.
 */
const READ_VERBS: ReadonlySet<string> = new Set(['select', 'table', 'values']);
const CTE_VERB = 'with';

/**
 * A word that disqualifies the whole statement. Matched with word boundaries against the raw
 * lowercased text — NOT against `stripSqlNoise`'d text, deliberately: a `;`-in-a-literal is data
 * and must not split a statement, but a `'update'` in a literal costing one read its replica is a
 * false positive on the SAFE side, and blanking every statement on the hot path to buy back that
 * one read is a cost axiom 6 refuses. `share` covers `for share` and `for key share`; `update`
 * covers `for update` and `for no key update`; `into` covers `select … into`, which creates a table.
 */
const WRITE_WORD =
  /\b(?:insert|update|delete|merge|truncate|copy|create|drop|alter|grant|revoke|call|do|lock|share|refresh|reindex|vacuum|analyze|set|reset|begin|commit|rollback|savepoint|into)\b/;

/**
 * Function names a word boundary cannot reach — `pg_advisory_lock` has a `_` before `advisory`, so
 * `\badvisory\b` never matches it. Every one of these either writes or mutates session state that
 * belongs to whichever backend ran it, and a standby accepts them silently rather than answering
 * `25006`, so the server's own refusal cannot be the safety net here the way it is for a real write.
 */
const UNSAFE_CALLS: readonly string[] = [
  'nextval',
  'setval',
  'set_config',
  'advisory',
  'dblink',
  'lo_import',
  'lo_export',
  'pg_export_snapshot',
  'pg_replication',
  'pg_create',
];

/**
 * Provably a plain read, or `false`. Never "probably": everything this cannot vouch for is the
 * primary's, so a statement shape nobody anticipated costs a replica opportunity and never a wrong
 * answer. That inversion is the whole difference from `readonly.ts`, whose 22-word deny-list read
 * `select pg_sleep(60)` as safe because the default was permission.
 */
export function isPlainRead(text: string): boolean {
  const lowered = text.toLowerCase();
  const verb = statementVerb(lowered);
  if (!READ_VERBS.has(verb) && verb !== CTE_VERB) return false;
  if (WRITE_WORD.test(lowered)) return false;
  return !UNSAFE_CALLS.some((call) => lowered.includes(call));
}
