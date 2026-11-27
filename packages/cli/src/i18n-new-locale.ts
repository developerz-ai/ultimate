// `x i18n add`'s one write: a locale with no catalog yet, created in the form the default locale is
// in — one flat file, or a directory holding the default's namespace files — and never over a
// catalog already there, in either form: a flat file beside a directory is `X_CATALOG_LAYOUT_MIXED`.

// why: `node:` and not Bun: Bun has no exclusive-create write, and `open(path, 'wx')` / `mkdir`
// without `recursive` are the only ones there are — `Bun.write` overwrites, so an existence check
// before it is a race a second `x i18n add` wins. `existsSync` because `Bun.file().exists()`
// answers false for a directory, and `node:path` because Bun exposes no path API.
import { existsSync } from 'node:fs';
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringField } from '@ultimat3/core';
import type { Catalog } from '@ultimat3/i18n';
import type { LocaleLayout } from './catalog-layout';
import { catalogWrites } from './catalog-layout';
import { CatalogExistsError } from './errors';
import { catalogDir, catalogPath } from './templates/locales';

/**
 * `open`'s and `mkdir`'s failure when the path is already there — the one errno translated here.
 *
 * `stringField`, never `'code' in error && error.code`: `in` narrows for the COMPILER and promises
 * the runtime nothing, so a throwing getter takes the command down one line after the guard.
 */
const isAlreadyExists = (error: unknown): boolean => stringField(error, 'code') === 'EEXIST';

/** Runs the exclusive create, answering `CatalogExistsError` for a path someone got to first. */
async function exclusive<T>(locale: string, path: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isAlreadyExists(error)) throw new CatalogExistsError({ locale, path });
    throw error;
  }
}

/** The other form already on disk is a catalog too: refused before anything is created. */
function refuseOtherForm(root: string, locale: string, other: string): void {
  if (existsSync(join(root, other))) throw new CatalogExistsError({ locale, path: other });
}

/**
 * Writes `catalog` as `locale`'s new catalog, shaped like `source` (the default locale's layout),
 * and answers where it landed. The exclusive step is the file itself for a flat locale and the
 * directory for a split one, so two concurrent `x i18n add fr` never both succeed.
 */
export async function writeNewLocale(
  root: string,
  locale: string,
  catalog: Catalog,
  source: LocaleLayout | undefined,
): Promise<string> {
  const split = source?.form === 'split';
  const writes = catalogWrites(locale, catalog, split ? 'split' : 'flat', source?.files);
  if (!split) {
    refuseOtherForm(root, locale, catalogDir(locale));
    const absolute = join(root, catalogPath(locale));
    await mkdir(dirname(absolute), { recursive: true });
    const handle: FileHandle = await exclusive(locale, catalogPath(locale), () =>
      open(absolute, 'wx'),
    );
    try {
      await handle.writeFile(writes[0]?.contents ?? '{}\n');
    } finally {
      await handle.close();
    }
    return catalogPath(locale);
  }
  refuseOtherForm(root, locale, catalogPath(locale));
  const dir = join(root, catalogDir(locale));
  await mkdir(dirname(dir), { recursive: true });
  await exclusive(locale, `${catalogDir(locale)}/`, () => mkdir(dir));
  for (const file of writes) await Bun.write(join(root, file.path), file.contents);
  return `${catalogDir(locale)}/`;
}
