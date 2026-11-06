// Single responsibility: the SQL of the database's own tenant guard — enable and FORCE row level
// security on a tenant table, one policy reading the transaction-local `x.tenant` / `x.cross`, and
// the drop. Pure text: the generator emits it, the drift repair pastes it, the live test runs it.

import { identifierUnsafe } from './errors';
import { identifier } from './sql';

/** The one policy name, the same on every table: a policy name is unique per table. */
export const ROW_SECURITY_POLICY = 'ultimate_tenant';
/** The settings `setLocal` writes and the policy reads. Never set at session level. */
export const TENANT_SETTING = 'x.tenant';
export const CROSS_TENANT_SETTING = 'x.cross';

/**
 * A Postgres type name as an entity column records it (`uuid`, `text`, `bigint`, `integer`). A
 * closed shape, re-derived rather than spliced: `create policy` takes no parameter, so a type
 * reaching it is text, and anything but a plain (optionally spaced) word is refused upstream.
 */
const TYPE = /^[a-z][a-z0-9 ]*$/;

/**
 * Unset is `''` (a `set_config` local value reads back as `''` once its transaction ends) and
 * `nullif` turns it into NULL, so an unset tenant matches NO row: fail closed, never open.
 */
function predicate(column: string, type: string): string {
  if (!TYPE.test(type)) throw identifierUnsafe(type);
  return (
    `(${identifier(column).text} = nullif(current_setting('${TENANT_SETTING}', true), '')::${type}` +
    ` or current_setting('${CROSS_TENANT_SETTING}', true) = 'on')`
  );
}

/**
 * `enable` + `force` (an owner is exempt unless forced) + the policy, `using` for what a statement
 * may see and `with check` for what it may write: an insert naming another tenant is refused.
 */
export function enableRowSecuritySql(
  table: string,
  column: string,
  type: string,
): readonly string[] {
  const name = identifier(table).text;
  const rule = predicate(column, type);
  return [
    `alter table ${name} enable row level security;`,
    `alter table ${name} force row level security;`,
    `create policy ${identifier(ROW_SECURITY_POLICY).text} on ${name} using ${rule} with check ${rule};`,
  ];
}

/** The revert. `if exists`: a database where the policy was already dropped by hand must not fail. */
export function dropRowSecuritySql(table: string): readonly string[] {
  const name = identifier(table).text;
  return [
    `drop policy if exists ${identifier(ROW_SECURITY_POLICY).text} on ${name};`,
    `alter table ${name} no force row level security;`,
    `alter table ${name} disable row level security;`,
  ];
}
