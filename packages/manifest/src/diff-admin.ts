// The admin in a contract diff. An admin's list URLs are bookmarked and its MCP tools are called
// by agents, so what a list ANSWERS is contract: a filter, a sort or a scope that goes away
// refuses a caller it served, a default scope that moves changes what a bare URL lists, and a row
// scope that appears hides rows from actors who saw them. An action is an MCP tool: one that goes
// away, stops taking `ids`, or starts excluding rows (`when`) refuses a call it answered. A
// route's permissions are judged like any operation's; layout and related lists are internal.

import type { ManifestChange } from './diff-change';
import { diffNamedSet, index } from './diff-change';
import { diffPermissions } from './diff-operations';
import type { AdminActionFact, AdminFact, AdminResourceFact } from './schema';

/** A change of one boolean fact, breaking in one direction and additive in the other. */
const flag = (
  path: string,
  before: boolean,
  after: boolean,
  breaksWhen: boolean,
  detail: string,
): readonly ManifestChange[] =>
  before === after
    ? []
    : [
        {
          kind: after === breaksWhen ? 'breaking' : 'additive',
          path,
          detail: `${detail} ${String(before)} -> ${String(after)}`,
        },
      ];

/**
 * The admin-level gate, as `adminPermissionForAction` (`@ultimat3/admin`) decides it: `destructive`
 * and `matching` hold the write gate, and only then does `readonly` lower it. Restated, not
 * imported: the admin is a tier above this package. `destructive` reports its own change (and its
 * own `admin:destroy` gate), so this only says read or write.
 */
const gateOf = (action: AdminActionFact): 'admin:read' | 'admin:write' =>
  action.readonly && !action.destructive && !action.matching ? 'admin:read' : 'admin:write';

/** `readonly` / `matching` flipping: a caller sees it only when the gate moves. */
function diffGate(at: string, before: AdminActionFact, after: AdminActionFact): ManifestChange[] {
  const changes: ManifestChange[] = [];
  const [was, is] = [gateOf(before), gateOf(after)];
  if (was !== is) {
    // Write → read lets an `admin:read` caller in; read → write refuses one it served.
    const kind = is === 'admin:write' ? 'breaking' : 'additive';
    changes.push({ kind, path: `${at}.gate`, detail: `admin gate ${was} -> ${is}` });
  }
  for (const key of ['readonly', 'matching'] as const) {
    if (before[key] === after[key]) continue;
    const detail = `${key} ${String(before[key])} -> ${String(after[key])}`;
    changes.push({ kind: 'internal', path: `${at}.${key}`, detail });
  }
  return changes;
}

function diffActions(
  path: string,
  before: readonly AdminActionFact[],
  after: readonly AdminActionFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [
    ...diffNamedSet(
      path,
      before.map((action) => action.name),
      after.map((action) => action.name),
    ),
  ];
  const next = index(after, (action) => action.name);
  for (const action of before) {
    const now = next.get(action.name);
    if (now === undefined) continue;
    const at = `${path}.${action.name}`;
    changes.push(
      ...diffPermissions(
        at,
        { permissions: [action.permission] },
        { permissions: [now.permission] },
      ),
      // `when` appearing refuses rows the tool ran on; the batch path going away refuses `ids`;
      // a schema appearing refuses a call that sent nothing; destructive starts asking for a token.
      ...flag(`${at}.when`, action.when, now.when, true, 'when'),
      ...flag(`${at}.batch`, action.batch, now.batch, false, 'batch'),
      ...flag(`${at}.input`, action.input, now.input, true, 'input schema'),
      ...flag(`${at}.destructive`, action.destructive, now.destructive, true, 'destructive'),
    );
    changes.push(...diffGate(at, action, now));
    if (action.threshold !== now.threshold) {
      changes.push({
        kind: 'internal',
        path: `${at}.threshold`,
        detail: `threshold ${String(action.threshold)} -> ${String(now.threshold)}`,
      });
    }
  }
  return changes;
}

const layout = (sections: AdminResourceFact['sections']): string =>
  JSON.stringify(sections.map((section) => [section.title, section.fields]));

function diffResource(
  path: string,
  before: AdminResourceFact,
  after: AdminResourceFact,
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [
    ...diffNamedSet(`${path}.filters`, before.filters, after.filters),
    ...diffNamedSet(`${path}.sorts`, before.sorts, after.sorts),
    ...diffNamedSet(
      `${path}.scopes`,
      before.scopes.map((scope) => scope.name),
      after.scopes.map((scope) => scope.name),
    ),
  ];
  const next = index(after.scopes, (scope) => scope.name);
  for (const scope of before.scopes) {
    const now = next.get(scope.name);
    if (now === undefined) continue;
    if (scope.default !== now.default) {
      changes.push({
        kind: 'breaking',
        path: `${path}.scopes.${scope.name}.default`,
        detail: `default ${String(scope.default)} -> ${String(now.default)}; a bare list URL reads other rows`,
      });
    }
    if (scope.count !== now.count) {
      changes.push({
        kind: 'internal',
        path: `${path}.scopes.${scope.name}.count`,
        detail: `count ${String(scope.count)} -> ${String(now.count)}`,
      });
    }
  }
  changes.push(...diffActions(`${path}.actions`, before.actions, after.actions));
  // A related card is the related resource's own list, reachable on its own: neither direction
  // refuses a caller.
  changes.push(...diffNamedSet(`${path}.related`, before.related, after.related, 'internal'));
  for (const key of ['sections', 'formGroups'] as const) {
    if (layout(before[key]) !== layout(after[key])) {
      changes.push({ kind: 'internal', path: `${path}.${key}`, detail: `${key} rearranged` });
    }
  }
  if (before.rowScoped !== after.rowScoped) {
    changes.push({
      // Appearing narrows what every actor sees; going away widens it — which breaks nobody, and
      // is still a change a reviewer has to see.
      kind: after.rowScoped ? 'breaking' : 'additive',
      path: `${path}.rowScoped`,
      detail: after.rowScoped ? 'rows are now scoped per actor' : 'rows are no longer scoped',
    });
  }
  return changes;
}

function diffAdmin(before: AdminFact, after: AdminFact): readonly ManifestChange[] {
  const root = `admin.${before.basePath}`;
  const changes: ManifestChange[] = [];
  if (before.audit !== after.audit) {
    changes.push({
      kind: 'internal',
      path: `${root}.audit`,
      detail: `audit log ${before.audit} -> ${after.audit}`,
    });
  }

  const resources = index(after.resources, (resource) => resource.entity);
  for (const resource of before.resources) {
    const path = `${root}.resources.${resource.entity}`;
    const next = resources.get(resource.entity);
    if (next === undefined) changes.push({ kind: 'breaking', path, detail: 'resource removed' });
    else changes.push(...diffResource(path, resource, next));
  }
  const had = index(before.resources, (resource) => resource.entity);
  for (const resource of after.resources) {
    if (!had.has(resource.entity)) {
      changes.push({
        kind: 'additive',
        path: `${root}.resources.${resource.entity}`,
        detail: 'resource added',
      });
    }
  }

  const routes = index(after.routes, (route) => route.url);
  for (const route of before.routes) {
    const path = `${root}.routes.${route.url}`;
    const next = routes.get(route.url);
    if (next === undefined) changes.push({ kind: 'breaking', path, detail: 'route removed' });
    else changes.push(...diffPermissions(path, route, next));
  }
  const served = index(before.routes, (route) => route.url);
  for (const route of after.routes) {
    if (!served.has(route.url)) {
      changes.push({
        kind: 'additive',
        path: `${root}.routes.${route.url}`,
        detail: 'route added',
      });
    }
  }
  return changes;
}

export function diffAdmins(
  before: readonly AdminFact[],
  after: readonly AdminFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const next = index(after, (admin) => admin.basePath);
  const had = index(before, (admin) => admin.basePath);
  for (const admin of before) {
    const now = next.get(admin.basePath);
    if (now === undefined) {
      changes.push({ kind: 'breaking', path: `admin.${admin.basePath}`, detail: 'admin removed' });
    } else {
      changes.push(...diffAdmin(admin, now));
    }
  }
  for (const admin of after) {
    if (!had.has(admin.basePath)) {
      changes.push({ kind: 'additive', path: `admin.${admin.basePath}`, detail: 'admin added' });
    }
  }
  return changes;
}
