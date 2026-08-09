// Single responsibility: a `DbClient` that cannot mutate — for any caller that cannot open its
// own transaction. An LLM with a Postgres connection and no gate is an outage waiting to be
// prompted into existence. (MCP's `db.query` reaches past this for the stronger `readOnlyQuery`:
// a SELECT-only role inside `BEGIN READ ONLY`, where Postgres refuses the write, not a regex.)
// Detection strips comments and string literals first, because
// `/* x */ update ...` and `WITH t AS (INSERT ...) SELECT` are exactly how a naive check is beaten.

import type { DbClient } from './client';
import { readonlyViolation } from './errors';
import { raw, type SqlFragment } from './sql';

const MUTATING = [
  'insert',
  'update',
  'delete',
  'truncate',
  'drop',
  'alter',
  'create',
  'grant',
  'revoke',
  'copy',
  'set',
  'call',
  'do',
  'refresh',
  'vacuum',
  'reindex',
  'cluster',
  'lock',
  'merge',
  'analyze',
  'prepare',
  'execute',
] as const;

const MUTATING_PATTERN = new RegExp(`\\b(${MUTATING.join('|')})\\b`, 'i');

/**
 * Blank out anything a keyword could legitimately hide inside: line comments, block comments,
 * single-quoted literals, dollar-quoted bodies and quoted identifiers. Blanking (rather than
 * deleting) keeps offsets stable so the reported statement still reads correctly.
 */
export function stripSqlNoise(text: string): string {
  return text
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, ' "" ');
}

export interface MutationVerdict {
  readonly mutating: boolean;
  readonly keyword: string | null;
}

/**
 * Whole-text scan, not a leading-keyword check: multi-statement strings and CTEs that end in a
 * writing branch must both be caught, and a false positive here is far cheaper than a false
 * negative. `updated_at` and `offset` do not match — `\b` requires a non-word boundary.
 */
export function inspectStatement(text: string): MutationVerdict {
  const match = MUTATING_PATTERN.exec(stripSqlNoise(text));
  if (match === null) return { mutating: false, keyword: null };
  return { mutating: true, keyword: match[1] ?? match[0] };
}

export function assertReadOnly(fragment: SqlFragment): void {
  const verdict = inspectStatement(fragment.text);
  if (!verdict.mutating) return;
  throw readonlyViolation(fragment.text.trim().slice(0, 160), verdict.keyword ?? 'mutating');
}

export interface ReadOnlyOptions {
  /** Also ask Postgres to enforce it. Off only for clients that cannot run `SET TRANSACTION`. */
  readonly seal?: boolean | undefined;
}

/**
 * Belt and braces: the regex is the gate, `SET TRANSACTION READ ONLY` is the backstop for
 * anything the regex was too clever to catch. Sealing is best-effort — outside a transaction
 * block Postgres only warns, and a driver that rejects it must not break every read.
 */
export function readOnly(client: DbClient, options: ReadOnlyOptions = {}): DbClient {
  let sealed = options.seal === false;

  async function seal(): Promise<void> {
    if (sealed) return;
    sealed = true;
    await client.execute(raw('SET TRANSACTION READ ONLY')).catch(() => undefined);
  }

  return {
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      assertReadOnly(fragment);
      await seal();
      return client.query<T>(fragment);
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      assertReadOnly(fragment);
      await seal();
      return client.one<T>(fragment);
    },
    async execute(fragment: SqlFragment): Promise<number> {
      assertReadOnly(fragment);
      await seal();
      return client.execute(fragment);
    },
  };
}
