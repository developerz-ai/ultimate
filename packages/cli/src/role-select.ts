// `x dev --role`: which roles one dev process runs. Every value that is not a runnable selection
// is a flag error carrying the working invocation, never a silently narrowed or empty set.

import type { AppConfig, Role } from '@ultimat3/core';
import { ConfigInvalidError, isRole, logger, ROLES } from '@ultimat3/core';
import { BadFlagError } from './errors';
import { DEV_ROLES } from './role-start-types';
import { roleDeclared } from './serve-env';
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

/**
 * The selection narrowed to the roles `app.config.ts` declares — the rule the container's `ROLE` is
 * refused by (`roleDeclared`, `serve-env.ts`), so dev never fires a cron task, or binds a sync
 * node, that the deploy will not run. What it drops is named in one line; a selection of nothing
 * BUT undeclared roles is refused, as `rolesUnderRealtime` refuses one that would serve nothing.
 */
export function rolesDeclaredForDev(
  selected: readonly Role[],
  config: AppConfig | undefined,
): readonly Role[] {
  const kept = selected.filter((role) => roleDeclared(role, config));
  if (kept.length === selected.length || config === undefined) return selected;
  const dropped = selected.filter((role) => !kept.includes(role));
  if (kept.length === 0) {
    throw new ConfigInvalidError({
      cause: `role ${dropped.join(',')} was asked for and roles in app.config.ts lists ${config.roles.join(', ')}, so this process would serve nothing`,
      fix: `x dev --role ${quoteArg(config.roles.filter((role) => role !== 'migrate').join(','))}`,
      meta: { key: 'roles', roles: dropped, declared: [...config.roles] },
    });
  }
  // info: once per boot — what this process does NOT run, which nothing else would say.
  logger.info(`roles in app.config.ts does not list ${dropped.join(', ')}: not starting them`, {
    dropped,
    declared: [...config.roles],
  });
  return kept;
}
