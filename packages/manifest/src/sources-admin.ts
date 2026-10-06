// The admins this process declared, as manifest facts. `@ultimat3/admin` is a tier above this
// package and may not be imported, so its mount registry is read off the global symbol registry —
// the same seam `@ultimat3/cli` mounts the screens through — and each admin is asked to describe
// ITSELF. What comes back is `unknown` and is read field by field: a description this build does
// not understand is skipped whole, never half-published.

import type {
  AdminActionFact,
  AdminFact,
  AdminResourceFact,
  AdminRouteFact,
  AdminScopeFact,
  AdminSectionFact,
} from './schema';

/** `@ultimat3/admin`'s `ADMIN_MOUNTS`. Restated — the package cannot be imported from here. */
export const ADMIN_MOUNTS_KEY: symbol = Symbol.for('ultimate.admin.mounts');

type Bag = Readonly<Record<string, unknown>>;

const bagOf = (value: unknown): Bag | undefined =>
  typeof value === 'object' && value !== null ? (value as Bag) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const texts = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')
    ? (value as readonly string[])
    : undefined;

/** Every element read, or the whole list refused: a half-read list is a manifest that lies. */
const each = <T>(
  value: unknown,
  read: (one: unknown) => T | undefined,
): readonly T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const one of value) {
    const fact = read(one);
    if (fact === undefined) return undefined;
    out.push(fact);
  }
  return out;
};

const scopeOf = (value: unknown): AdminScopeFact | undefined => {
  const bag = bagOf(value);
  const name = text(bag?.['name']);
  if (bag === undefined || name === undefined) return undefined;
  return { name, default: bag['default'] === true, count: bag['count'] === true };
};

const sectionOf = (value: unknown): AdminSectionFact | undefined => {
  const bag = bagOf(value);
  const fields = texts(bag?.['fields']);
  const title = bag?.['title'];
  if (bag === undefined || fields === undefined) return undefined;
  if (title !== null && typeof title !== 'string') return undefined;
  return { title, fields };
};

const actionOf = (value: unknown): AdminActionFact | undefined => {
  const bag = bagOf(value);
  const name = text(bag?.['name']);
  const permission = text(bag?.['permission']);
  const threshold = bag?.['threshold'];
  if (bag === undefined || name === undefined || permission === undefined) return undefined;
  if (threshold !== null && typeof threshold !== 'number') return undefined;
  return {
    name,
    permission,
    destructive: bag['destructive'] === true,
    input: bag['input'] === true,
    when: bag['when'] === true,
    batch: bag['batch'] === true,
    threshold,
    readonly: bag['readonly'] === true,
    matching: bag['matching'] === true,
  };
};

const resourceOf = (value: unknown): AdminResourceFact | undefined => {
  const bag = bagOf(value);
  const entity = text(bag?.['entity']);
  const path = text(bag?.['path']);
  const filters = texts(bag?.['filters']);
  const sorts = texts(bag?.['sorts']);
  const scopes = each(bag?.['scopes'], scopeOf);
  const sections = each(bag?.['sections'], sectionOf);
  const formGroups = each(bag?.['formGroups'], sectionOf);
  const related = texts(bag?.['related']);
  const actions = each(bag?.['actions'], actionOf);
  if (
    bag === undefined ||
    entity === undefined ||
    path === undefined ||
    filters === undefined ||
    sorts === undefined ||
    scopes === undefined ||
    sections === undefined ||
    formGroups === undefined ||
    related === undefined ||
    actions === undefined
  ) {
    return undefined;
  }
  return {
    entity,
    path,
    filters,
    sorts,
    scopes,
    rowScoped: bag['rowScoped'] === true,
    sections,
    formGroups,
    related,
    actions,
  };
};

const routeOf = (value: unknown): AdminRouteFact | undefined => {
  const bag = bagOf(value);
  const url = text(bag?.['url']);
  const view = text(bag?.['view']);
  const permissions = texts(bag?.['permissions']);
  if (bag === undefined || url === undefined || view === undefined || permissions === undefined) {
    return undefined;
  }
  return { url, view, entity: text(bag['entity']) ?? null, permissions };
};

const adminOf = (mount: unknown): AdminFact | undefined => {
  const describe = bagOf(mount)?.['describe'];
  if (typeof describe !== 'function') return undefined;
  const described = bagOf((describe as () => unknown).call(mount));
  const basePath = text(described?.['basePath']);
  const audit = text(described?.['audit']);
  const resources = each(described?.['resources'], resourceOf);
  const routes = each(described?.['routes'], routeOf);
  if (
    basePath === undefined ||
    audit === undefined ||
    resources === undefined ||
    routes === undefined
  ) {
    return undefined;
  }
  return { basePath, audit, resources, routes };
};

/** Every admin `defineAdmin()` declared in this process. Empty for an app that declares none. */
export function declaredAdmins(): readonly AdminFact[] {
  const held = (globalThis as { [key: symbol]: unknown })[ADMIN_MOUNTS_KEY];
  if (!(held instanceof Map)) return [];
  return [...held.values()].flatMap((mount) => {
    const fact = adminOf(mount);
    return fact === undefined ? [] : [fact];
  });
}
