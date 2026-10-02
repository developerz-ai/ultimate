// The catalog keys the admin reads for a generated entity. An entity in the app's handle IS an
// admin screen — `defineAdmin({ entities: adminEntitiesOf(db) })` — and that screen resolves
// `admin.<table>.title` and one `admin.<table>.field.<column>` per column. Nothing emitted them, so
// a generated list rendered `⟦admin.widgets.field.title⟧` in every header.

import { catalogJson } from './catalog-json';
import type { FeatureTarget } from './entity';
import { entityFiles } from './entity';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile } from './naming';
import { kebab, names } from './naming';

/** `    title: text({ max: 200 }),` — one column of the entity this same run writes. */
const COLUMN_LINE = /^ {4}([A-Za-z_$][\w$]*): [A-Za-z_$][\w$]*\(/gm;

/** `createdAt` → `Created at`, `orgId` → `Org ID`: a label a person reads, in sentence case. */
export const columnLabel = (property: string): string => {
  const words = kebab(property)
    .split('-')
    .map((word) => (word === 'id' ? 'ID' : word));
  const [first = '', ...rest] = words;
  return [`${first[0]?.toUpperCase() ?? ''}${first.slice(1)}`, ...rest].join(' ');
};

/**
 * The entries, keyed exactly as `@ultimat3/admin` derives them: both read the entity's own name
 * (`$name`, the table) and its property names. The columns come off the entity this run writes —
 * never a second list typed here — so a column added to the template is a label added with it.
 */
export function adminCatalogEntries(
  rawName: string,
  target: FeatureTarget,
): Readonly<Record<string, string>> {
  const name = names(rawName);
  const source = String(
    entityFiles(rawName, target).find((file) => file.path.endsWith('/entity.ts'))?.contents ?? '',
  );
  const entries: Record<string, string> = {
    [`admin.${name.table}.title`]: columnLabel(name.plural),
  };
  for (const match of source.matchAll(COLUMN_LINE)) {
    const property = match[1] ?? '';
    entries[`admin.${name.table}.field.${property}`] = columnLabel(property);
  }
  return entries;
}

/** One mergeable catalog file per locale — for `x g entity`, which has no other catalog entry. */
export const adminCatalogFiles = (
  rawName: string,
  target: FeatureTarget,
  locales: readonly string[] | undefined,
): readonly GeneratedFile[] =>
  resolveLocales(locales).map((locale) => ({
    path: catalogPath(locale),
    contents: catalogJson(adminCatalogEntries(rawName, target)),
    merge: 'json' as const,
  }));
