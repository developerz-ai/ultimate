// Everything `x g` edits OUTSIDE the files it creates, in the one order they have to happen: a
// declared permission granted to a role, a primitive listed in `defineApi`, an entity added to the
// typed handle, an `--admin` override wired, each new workspace edge declared, and every catalog
// made selectable. One function over one disk seam, so a real run and a dry run are the same code
// — and the dry run's list of touched files is what the run touches, not a second guess at it.

import { registerAdminResources } from './admin-registration';
import { registerGeneratedPrimitives } from './api-registration';
import type { GenerateDisk } from './generate-disk';
import { ungrantedByGenerator } from './generate-grant-findings';
import { grantGeneratedPermissions } from './generate-grants';
import { declareGeneratedImports } from './generated-imports';
import { registerGeneratedEntities } from './handle-registration';
import { syncI18nIndex } from './i18n-index';
import type { Finding } from './output';
import { CATALOG_ROOT } from './templates';

export interface FollowUps {
  /** App-root-relative paths edited or created beyond the generator's own files, each once. */
  readonly edited: readonly string[];
  readonly findings: readonly Finding[];
}

/** The locale each written catalog file is for: a dry run's catalogs are not on the disk yet. */
const writtenLocales = (written: readonly string[]): readonly string[] =>
  written.flatMap((path) => {
    const stem = path.startsWith(`${CATALOG_ROOT}/`) ? path.slice(CATALOG_ROOT.length + 1) : '';
    return stem.endsWith('.json') && !stem.includes('/') ? [stem.slice(0, -'.json'.length)] : [];
  });

export async function followUpEdits(
  root: string,
  written: readonly string[],
  dbModule: string | undefined,
  disk: GenerateDisk,
): Promise<FollowUps> {
  const handle = await registerGeneratedEntities(root, written, dbModule, disk);
  const adminWiring = await registerAdminResources(root, written, disk);
  const granted = await grantGeneratedPermissions(root, written, disk);
  const listed = await registerGeneratedPrimitives(root, written, disk);
  // Last of the manifest writers, because the others add imports too: every sibling workspace a
  // written file imports, declared in the manifest it landed under.
  const imports = await declareGeneratedImports(root, written, disk);
  // A grant that edit could not place is said so, with the role each permission belongs to.
  const ungranted = await ungrantedByGenerator(root, written, disk);
  // A catalog on disk and a locale the app can select are two facts — see `syncI18nIndex`.
  const indexSync =
    written.length > 0
      ? await syncI18nIndex(root, disk, writtenLocales(written))
      : { registered: true, findings: [] };
  return {
    edited: [
      ...new Set([
        ...granted,
        ...listed,
        ...handle.edited,
        ...adminWiring.edited,
        ...imports,
        ...(indexSync.edited ?? []),
      ]),
    ].filter((path) => !written.includes(path)),
    findings: [...handle.findings, ...ungranted, ...adminWiring.findings, ...indexSync.findings],
  };
}
