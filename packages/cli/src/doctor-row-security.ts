// Single responsibility: `x doctor`'s row-security questions, asked without booting — with
// `database.rowSecurity` on, is the serving role one Postgres applies policies to (the boot's own
// `X_DB_ROW_SECURITY_BYPASSED`); with it off, does raw `sql` reach a tenant table the policy would guard.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import {
  APP_CONFIG_FILE,
  ERROR_DOCS_URL,
  endOfLiteral,
  maskLiterals,
  resolveRole,
  stripComments,
} from '@ultimat3/core';
import { assertRowSecurityBinds, DbError, postgresClient } from '@ultimat3/db';
import { describeTenancy } from '@ultimat3/entity';
import { statementTables } from '@ultimat3/testing';
import { loadAppConfig } from './app-config-load';
import { loadApp } from './app-load';
import type { Finding } from './output';
import { findingFrom } from './output';
import { rowSecurityDeclared } from './row-security-boot';

import { eachSourceFile } from './source-files';

/**
 * External databases only: an embedded one serves as `x_app` by construction (`serveAsAppRole`).
 * An unreachable server is `database()`'s finding to make, so only the exemption is reported here.
 * The flag-against-migrations half is `X_DB_ROW_SECURITY_DRIFT`, reported by the drift probe.
 */
export async function rowSecurityProbe(
  root: string,
  url: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly Finding[]> {
  if (url === undefined || url.trim() === '') return [];
  if (!rowSecurityDeclared(await loadAppConfig(root))) return [];
  const client = postgresClient({
    url,
    role: resolveRole({ env }),
    env,
    applicationName: 'x-doctor',
  });
  try {
    await assertRowSecurityBinds(client);
    return [];
  } catch (error) {
    return error instanceof DbError && error.code === 'X_DB_ROW_SECURITY_BYPASSED'
      ? [findingFrom(error)]
      : [];
  } finally {
    await client.close();
  }
}

export const ROW_SECURITY_OFF = 'X_DB_ROW_SECURITY_OFF';

/** One raw `sql\`…\`` statement in the app's source naming a tenant table. */
export interface RawTenantSql {
  readonly at: string;
  readonly table: string;
}

/** The other question: with `database.rowSecurity` OFF, does raw SQL reach a tenant table? */
export interface RowSecurityOffFact {
  readonly declared: boolean;
  readonly touches: readonly RawTenantSql[];
}

/**
 * The repository scopes every entity read by its tenant column; a raw `sql\`…\`` statement is
 * outside that scope, and only the database's own policy (`database.rowSecurity`) holds there. Off
 * with no raw tenant SQL is a decision with nothing riding on it, and is not reported.
 */
export function rowSecurityOffFindings(fact: RowSecurityOffFact): readonly Finding[] {
  if (fact.declared || fact.touches.length === 0) return [];
  const tables = [...new Set(fact.touches.map((touch) => touch.table))].sort();
  const sites = fact.touches.slice(0, 5).map((touch) => `${touch.at} (${touch.table})`);
  return [
    {
      code: ROW_SECURITY_OFF,
      cause: `database.rowSecurity is off and ${fact.touches.length} raw sql statement(s) name tenant table(s) ${tables.join(', ')} — ${sites.join(', ')}: the repository's tenant scope does not reach a raw statement, so one missing tenant predicate reads every tenant's rows`,
      fix: `database: { rowSecurity: true }   # in defineConfig, ${APP_CONFIG_FILE}; then: x db gen "row security" --json && x db migrate --json && x doctor --json`,
      docs: ERROR_DOCS_URL,
      at: APP_CONFIG_FILE,
    },
  ];
}

/**
 * A tagged `sql` template — `@ultimat3/db`'s, Bun's own `Bun.sql`, or a handle's `tx.sql` — found
 * in the masked text so a quoted or commented one is not one; `mysql\`` is a longer name, not it.
 */
const SQL_TAG = /(?<![\w$])sql\s*`/g;
/** `raw('…')` (a statement) and `identifier('…')` (a table name): SQL built outside a template. */
const SQL_CALL = /(?<![\w$.])(raw|identifier)\s*\(\s*/g;

/** The rule's scan, pure: each raw `sql` template or call in `source` naming one of `tables`. */
export function rawTenantSql(
  path: string,
  source: string,
  tables: ReadonlySet<string>,
): readonly RawTenantSql[] {
  if (tables.size === 0 || !/sql|raw|identifier/.test(source)) return [];
  const masked = maskLiterals(source);
  const text = stripComments(source);
  const found: RawTenantSql[] = [];
  const report = (index: number, named: readonly string[]) => {
    const line = text.slice(0, index).split('\n').length;
    for (const table of new Set(named)) {
      if (tables.has(table)) found.push({ at: `${path}:${line}`, table });
    }
  };
  // `scope` is masked text or a template's own body, `offset` where it starts in `text`.
  const calls = (scope: string, offset: number) => {
    for (const call of scope.matchAll(SQL_CALL)) {
      const open = offset + call.index + call[0].length;
      const quote = text[open];
      if (quote !== "'" && quote !== '"' && quote !== '`') continue;
      const literal = text.slice(open + 1, endOfLiteral(text, open) - 1);
      const named = call[1] === 'raw' ? statementTables(literal) : [literal.toLowerCase()];
      report(offset + call.index, named);
    }
  };
  for (const tag of masked.matchAll(SQL_TAG)) {
    const open = tag.index + tag[0].length - 1;
    const body = text.slice(open + 1, endOfLiteral(text, open) - 1);
    report(tag.index, statementTables(body));
    // Masking blanks a template's `${…}` too: `${identifier('posts')}` is read off the body.
    calls(body, open + 1);
  }
  calls(masked, 0);
  return found;
}

/** Migrations and seeds are SQL by design; tests are fixtures. */
const NOT_JUDGED = /(?:^|\/)(?:migrations|seeds?)\/|\.test\.tsx?$|\.d\.ts$/;

/**
 * The I/O half: the flag, and the app's raw tenant SQL. An app that will not load declares no
 * tenant table here — `snapshots()` already reports why it will not load.
 */
export async function rowSecurityOffProbe(root: string): Promise<RowSecurityOffFact> {
  const declared = rowSecurityDeclared(await loadAppConfig(root).catch(() => undefined));
  if (declared) return { declared, touches: [] };
  const loaded = await loadApp(root);
  if (loaded.findings.length > 0) return { declared, touches: [] };
  const tables = new Set(describeTenancy().map((tenant) => tenant.table.toLowerCase()));
  const touches: RawTenantSql[] = [];
  for await (const path of eachSourceFile(root)) {
    if (NOT_JUDGED.test(path)) continue;
    touches.push(...rawTenantSql(path, await Bun.file(join(root, path)).text(), tables));
  }
  return { declared, touches };
}
