// Single responsibility: a table's row security as dump statements — the `enable` and `force`
// flags, then each policy with every clause spelled. Pure; `schema-dump.ts` files them under
// `10_policies/`, after every table, function and role-free object they could name.

import type { CatalogPolicy, CatalogRowSecurity } from './catalog';
import { quoted } from './schema-dump-table';

export const rowSecurityStatements = (entry: CatalogRowSecurity): readonly string[] => [
  ...(entry.enabled ? [`alter table ${quoted(entry.table)} enable row level security;`] : []),
  ...(entry.forced ? [`alter table ${quoted(entry.table)} force row level security;`] : []),
];

/** `public` is a keyword here, never a quoted role: `to "public"` names a role called public. */
const grantee = (role: string): string => (role === 'public' ? role : quoted(role));

export function policyStatement(policy: CatalogPolicy): string {
  const clauses = [
    `create policy ${quoted(policy.name)} on ${quoted(policy.table)}`,
    `as ${policy.permissive ? 'permissive' : 'restrictive'}`,
    `for ${policy.command}`,
    `to ${policy.roles.map(grantee).join(', ')}`,
  ];
  if (policy.using !== null) clauses.push(`using (${policy.using})`);
  if (policy.withCheck !== null) clauses.push(`with check (${policy.withCheck})`);
  return `${clauses.join(' ')};`;
}
