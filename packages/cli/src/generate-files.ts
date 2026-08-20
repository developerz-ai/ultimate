// Which files each generator kind emits, as a pure function of its options. Split from
// `cmd-generate.ts` so a generator's output can be asserted on — by the generator tests, the
// scaffold fixture and `x new` — without a command line, an app root or a filesystem.

import { CliNotImplementedError } from './errors';
import type { Generator } from './generate-kinds';
import { assertSurfaceSupported, GENERATORS } from './generate-kinds';
import { dedupe } from './generate-write';
import type { GeneratedFile, Surface } from './templates';
import {
  actionFiles,
  adminPageFiles,
  backfillFiles,
  entityFiles,
  guardFiles,
  islandFiles,
  jobFiles,
  kebab,
  policyFiles,
  queryFiles,
  resourceFiles,
  routeFiles,
  taskFiles,
} from './templates';

export interface GenerateOptions {
  readonly kind: Generator;
  readonly name: string;
  readonly feature?: string;
  readonly surface?: Surface;
  readonly live?: boolean;
  /** `resource` only: also emit the per-entity admin override. */
  readonly admin?: boolean;
  /** Every locale a generated i18n catalog entry ships for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
  /**
   * `island` and `admin:page`: the directory the generated files land in. Named rather than
   * derived, because neither destination is derivable — `X_ISLAND_INVALID`'s cause already holds
   * the path a page's `src` resolved to, and an app's admin is wherever its `defineAdmin` is.
   */
  readonly at?: string;
  /** `admin:page` only: the permission the page's own work needs, on top of `admin:read`. */
  readonly permission?: string;
  /**
   * The app's own catalog module, `@<app>/i18n` — what every generated component imports `useT()`
   * from. Supplied by `run` through `resolveCatalogModule`, because a template is a pure string
   * function and the package name lives in a manifest on disk. Absent for an app with no catalog
   * package, and only then does a generated file import `t` from `@ultimat3/i18n` instead.
   */
  readonly catalogModule?: string;
}

const DEFAULT_SURFACE_DIR: Record<Surface, string> = {
  site: 'apps/web/site',
  app: 'apps/web/app',
};

/**
 * Pure: returns the files a generator would write. `x g` writes them, the generator test asserts
 * on them, and nothing has to run a filesystem to review what a generator produces.
 */
export function generate(options: GenerateOptions): readonly GeneratedFile[] {
  const surface: Surface = options.surface ?? 'app';
  assertSurfaceSupported(options.kind, surface, options.name);
  const surfaceDir = DEFAULT_SURFACE_DIR[surface];
  const feature = options.feature ?? options.name;
  const target = { surfaceDir, feature };
  switch (options.kind) {
    case 'resource':
      return dedupe(
        resourceFiles(options.name, {
          ...target,
          admin: options.admin === true,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.catalogModule === undefined ? {} : { catalogModule: options.catalogModule }),
        }),
      );
    case 'action':
      return dedupe(actionFiles(options.name, target));
    case 'mutator':
      return dedupe(actionFiles(options.name, { ...target, mutator: true }));
    case 'backfill':
      return dedupe(backfillFiles(options.name, target));
    case 'entity':
      return dedupe(entityFiles(options.name, target));
    case 'policy':
      return dedupe(policyFiles(options.name, target));
    case 'query':
      return dedupe(queryFiles(options.name, { ...target, live: options.live === true }));
    case 'job':
      return dedupe(jobFiles(options.name, target));
    case 'task':
      return dedupe(taskFiles(options.name, target));
    case 'island':
      return dedupe(islandFiles(options.name, { dir: options.at ?? `${surfaceDir}/${feature}` }));
    // No `--at`, no surface, no feature: `guards/` is the one directory the gate discovers, and a
    // guard that lived anywhere else would need an app-side registration to be found.
    case 'guard':
      return dedupe(guardFiles(options.name));
    case 'admin:page':
      // A default permission, never none: an empty list is `X_ADMIN_PAGE_UNGUARDED` on sight.
      return dedupe(
        adminPageFiles(options.name, {
          permission: options.permission ?? `${kebab(options.name)}:read`,
          // The same `--at` `island` takes: an app's admin is wherever its `defineAdmin` is.
          ...(options.at === undefined ? {} : { dir: options.at }),
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.catalogModule === undefined ? {} : { catalogModule: options.catalogModule }),
        }),
      );
    case 'route':
      // `--locales` reaches the route generator too: its catalog entry is the route's title and
      // description, and a locale asked for on the command line is a locale that gets a file.
      return dedupe(
        routeFiles(options.name, {
          surface,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.catalogModule === undefined ? {} : { catalogModule: options.catalogModule }),
        }),
      );
    default:
      throw new CliNotImplementedError({
        feature: `generator "${String(options.kind)}"`,
        fix: `x g ${GENERATORS.join('|')}`,
      });
  }
}
