// `x dev --role`: which roles one dev process runs. Every value that is not a runnable selection
// is a flag error carrying the working invocation, never a silently narrowed or empty set.

import type { Role } from '@ultimat3/core';
import { isRole, ROLES } from '@ultimat3/core';
import { BadFlagError } from './errors';
import { DEV_ROLES } from './role-start-types';
import { quoteArg } from './shell-quote';

/**
 * What `--role` accepts. The replicator is here but not in `DEV_ROLES`: opt-in, because it takes
 * the one replication slot a database has, and a default that did that would mean two developers
 * pointed at one staging database silently fighting over it.
 */
export const SELECTABLE_ROLES: readonly Role[] = [...DEV_ROLES, 'replicator'];

/**
 * `--role web,worker` picks a subset. An unknown or out-of-scope role is a flag error with the
 * working invocation in the fix line, never a silently ignored value — which is what it was.
 */
export function selectRoles(flag: string | undefined): readonly Role[] {
  if (flag === undefined || flag.trim().length === 0) return DEV_ROLES;
  const wanted = flag
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // `--role ,` names nothing: read as "no roles" it booted an `x dev` that served nothing.
  if (wanted.length === 0) {
    throw new BadFlagError({
      flag: 'role',
      command: 'dev',
      reason: `it names no role (one or more of: ${SELECTABLE_ROLES.join(', ')})`,
      fix: `x dev --role ${quoteArg(DEV_ROLES.join(','))}`,
    });
  }
  const selected: Role[] = [];
  for (const name of wanted) {
    if (!isRole(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" is not a role (known: ${ROLES.join(', ')})`,
        fix: `x dev --role ${quoteArg(DEV_ROLES.join(','))}`,
      });
    }
    if (!SELECTABLE_ROLES.includes(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" does not run under x dev (it runs once, as \`x db migrate\`)`,
        fix: `x dev --role ${quoteArg(DEV_ROLES.join(','))}`,
      });
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return SELECTABLE_ROLES.filter((role) => selected.includes(role));
}
