// Which files each generator kind emits, as a pure function of its options. Split from
// `cmd-generate.ts` so a generator's output can be asserted on — by the generator tests, the
// scaffold fixture and `x new` — without a command line, an app root or a filesystem.

import { NotImplementedError } from '@ultimat3/core';
import { BadFlagError } from './errors';
import type { Generator } from './generate-kinds';
import { assertLiveSupported, assertSurfaceSupported, GENERATORS } from './generate-kinds';
import { dedupe } from './generate-write';
import { quoteArg } from './shell-quote';
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
  names,
  policyFiles,
  queryFiles,
  resourceFiles,
  routeFiles,
  shippedGuardFiles,
  taskFiles,
} from './templates';
import { adminCatalogFiles } from './templates/admin-catalog';

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
  /**
   * `action` and `mutator`: the slice's `errors.ts` as it stands on disk, absent when there is
   * none. Supplied by `run` for `catalogModule`'s reason — whether the slice declares
   * `<Feature>NotFoundError` is a fact about THIS app, and a template that assumed it wrote an
   * import of a class the app never declared. Read at `sliceDir(surface, feature)/errors.ts`.
   */
  readonly sliceErrors?: string;
  /**
   * `action`, `mutator`, `query`, `job`, `task` and `backfill`: the slice's `entity.ts` as it stands on disk, absent when
   * the feature has no entity yet — and then none is written. Supplied by `run` for `sliceErrors`'s reason — whether the feature is
   * tenant-scoped is a fact about THIS app, and a template that assumed `tenant: 'orgId'` wrote
   * `repo.byId`/`repo.list` calls into a feature whose entity names no tenant column. Read at
   * `sliceDir(surface, feature)/entity.ts`.
   */
  readonly sliceEntity?: string;
  /** The same kinds: the slice's `repo.ts` as it stands on disk, absent alongside `sliceEntity`. */
  readonly sliceRepo?: string;
  /**
   * The app's own db package, `@<app>/db` — what every generated `repo.ts` imports the typed handle
   * from. Supplied by `run` (`resolveDbModule`) for `catalogModule`'s reason: the name lives in a
   * manifest on disk. Every kind that can write a slice's `repo.ts` reads it, so it rides on the
   * shared target rather than on one case.
   */
  readonly dbModule?: string;
  /**
   * `resource` only: the app has the frame `x new` writes (`apps/web/shared/shell.tsx`), so the
   * resource's page renders inside it. Read off the disk by `run`, for `catalogModule`'s reason.
   */
  readonly shell?: boolean;
}

const DEFAULT_SURFACE_DIR: Record<Surface, string> = {
  site: 'apps/web/site',
  app: 'apps/web/app',
};

/** Where a feature slice lives, relative to the app root — the one derivation `run` reads from. */
export const sliceDir = (surface: Surface, feature: string): string =>
  `${DEFAULT_SURFACE_DIR[surface]}/${feature}`;

/**
 * `x g resource <name> --feature <other>`. A resource IS its feature: every file it composes — the
 * actions, the live query, the job — names the entity after the slice (`../entity`'s `Run`,
 * `canRunWrite`), so a slice under a second name is a set of imports that resolve to nothing. The
 * flag was read and then overwritten with the name, which wrote the slice somewhere the author did
 * not ask for and said nothing. Refused instead; a value that only restates the name is no second
 * name.
 */
function refuseResourceFeature(options: GenerateOptions, surfaceDir: string): void {
  if (options.kind !== 'resource' || options.feature === undefined) return;
  const named = kebab(options.name);
  if (kebab(options.feature) === named) return;
  throw new BadFlagError({
    flag: 'feature',
    command: 'g resource',
    reason: `a resource names its own slice — "${options.name}" is written to ${surfaceDir}/${named}/ and its page to ${surfaceDir}/${names(options.name).pluralKebab}/ — so --feature ${options.feature} would be a second name for one slice`,
    fix: `x g resource ${quoteArg(options.name)}`,
  });
}

/**
 * Pure: returns the files a generator would write. `x g` writes them, the generator test asserts
 * on them, and nothing has to run a filesystem to review what a generator produces.
 */
export function generate(options: GenerateOptions): readonly GeneratedFile[] {
  const surface: Surface = options.surface ?? 'app';
  assertSurfaceSupported(options.kind, surface, options.name);
  assertLiveSupported(options.kind, options.live === true, options.name);
  const surfaceDir = DEFAULT_SURFACE_DIR[surface];
  refuseResourceFeature(options, surfaceDir);
  // Kebab, always: `x g entity BlogPost` wrote `app/BlogPost/` while `resource` wrote
  // `app/blog-post/`, so one feature grew two slice directories depending on the generator.
  const feature = kebab(options.feature ?? options.name);
  const target = {
    surfaceDir,
    feature,
    ...(options.dbModule === undefined ? {} : { dbModule: options.dbModule }),
  };
  switch (options.kind) {
    case 'resource':
      return dedupe(
        resourceFiles(options.name, {
          ...target,
          admin: options.admin === true,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.catalogModule === undefined ? {} : { catalogModule: options.catalogModule }),
          ...(options.shell === undefined ? {} : { shell: options.shell }),
        }),
      );
    case 'action':
      return dedupe(
        actionFiles(options.name, {
          ...target,
          ...(options.sliceErrors === undefined ? {} : { sliceErrors: options.sliceErrors }),
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'mutator':
      return dedupe(
        actionFiles(options.name, {
          ...target,
          mutator: true,
          ...(options.sliceErrors === undefined ? {} : { sliceErrors: options.sliceErrors }),
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'backfill':
      return dedupe(
        backfillFiles(options.name, {
          ...target,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'entity':
      // With the labels the admin reads for it: the entity is an admin screen once it is in the
      // handle, whether or not a resource was generated around it.
      return dedupe([
        ...entityFiles(options.name, target),
        ...adminCatalogFiles(options.name, target, options.locales),
      ]);
    case 'policy':
      return dedupe(policyFiles(options.name, target));
    case 'query':
      return dedupe(
        queryFiles(options.name, {
          ...target,
          live: options.live === true,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'job':
      return dedupe(
        jobFiles(options.name, {
          ...target,
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'task':
      return dedupe(
        taskFiles(options.name, {
          ...target,
          ...(options.sliceEntity === undefined ? {} : { sliceEntity: options.sliceEntity }),
          ...(options.sliceRepo === undefined ? {} : { sliceRepo: options.sliceRepo }),
        }),
      );
    case 'island':
      return dedupe(islandFiles(options.name, { dir: options.at ?? `${surfaceDir}/${feature}` }));
    // No `--at`, no surface, no feature: `guards/` is the one directory the gate discovers, and a
    // guard that lived anywhere else would need an app-side registration to be found.
    // A name the framework ships a guard under gets THAT guard — how an app adopts one it does
    // not have (`x doctor` names them). Any other name is the app's own convention, from the blank
    // template.
    case 'guard':
      return dedupe(shippedGuardFiles(kebab(options.name)) ?? guardFiles(options.name));
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
      throw new NotImplementedError({
        cause: `generator "${String(options.kind)}" is not implemented in this build`,
        fix: `x g ${GENERATORS.join('|')}`,
      });
  }
}
