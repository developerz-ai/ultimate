// Navigation derived from the resources, grouped, and filtered by the same `admin:read` +
// `<entity>:read` pair that gates the page itself. A nav item an actor cannot open is not a
// nav item — the alternative is a sidebar full of 403s.

import { isAllowed } from './authz';
import type { CrudCtx } from './crud';
import { canOperate } from './crud';
import type { AdminResource } from './resource';

export interface NavItem {
  readonly key: string;
  readonly labelKey: string;
  readonly href: string;
  /** The entity this item lists, or `null` for a built-in page. */
  readonly entity: string | null;
  /**
   * What opening it needs. Set for a custom page (`pages.ts`), absent for a resource item —
   * whose gate is its own `list` operation. Without it, an item with no entity was visible to
   * everyone, which put a link to an ops screen in the sidebar of an actor the page refuses.
   */
  readonly permissions?: readonly string[];
}

export interface NavGroup {
  readonly key: string;
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

export interface NavOptions {
  /** Explicit group order and membership: `{ 'admin.group.content': ['post', 'tag'] }`. */
  readonly groups?: Readonly<Record<string, readonly string[]>>;
  /** Extra items (dashboards, links) appended to their group. */
  readonly extra?: readonly (NavItem & { readonly group: string })[];
}

const itemFor = (resource: AdminResource): NavItem => ({
  key: resource.name,
  labelKey: resource.titleKey,
  href: resource.path,
  entity: resource.name,
});

/**
 * Declaration order is the default order: an entity registry is written in the order the
 * domain reads, and re-sorting it alphabetically loses that.
 */
export function adminNav(
  resources: readonly AdminResource[],
  opts: NavOptions = {},
): readonly NavGroup[] {
  const byKey = new Map<string, NavItem[]>();
  const order: string[] = [];

  const push = (groupKey: string, item: NavItem): void => {
    let bucket = byKey.get(groupKey);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(groupKey, bucket);
      order.push(groupKey);
    }
    bucket.push(item);
  };

  if (opts.groups !== undefined) {
    for (const [groupKey, names] of Object.entries(opts.groups)) {
      for (const name of names) {
        const resource = resources.find((candidate) => candidate.name === name);
        if (resource !== undefined) push(groupKey, itemFor(resource));
      }
    }
  }

  const placed = new Set([...byKey.values()].flat().map((item) => item.entity ?? item.key));
  for (const resource of resources) {
    if (placed.has(resource.name)) continue;
    push(resource.group, itemFor(resource));
  }

  for (const item of opts.extra ?? []) push(item.group, item);

  return order.map((groupKey) => ({
    key: groupKey,
    labelKey: groupKey,
    items: byKey.get(groupKey) ?? [],
  }));
}

/** Drop items the actor cannot list, then drop groups that emptied out. */
export function visibleNav(
  nav: readonly NavGroup[],
  resources: readonly AdminResource[],
  ctx: CrudCtx,
): readonly NavGroup[] {
  const visible = (item: NavItem): boolean => {
    if (item.permissions !== undefined && !isAllowed(ctx.authz, item.permissions, ctx.actor)) {
      return false;
    }
    if (item.entity === null) return true;
    const resource = resources.find((candidate) => candidate.name === item.entity);
    return resource !== undefined && canOperate(resource, 'list', ctx);
  };

  return nav
    .map((group) => ({ ...group, items: group.items.filter(visible) }))
    .filter((group) => group.items.length > 0);
}
