// Public surface of the template modules. Templates are string modules, not copied fixture files,
// so `x g` output is typed, reviewable in a diff and testable without touching the filesystem.

export type { ActionOptions } from './action';
export { actionFiles } from './action';
export { adminFiles } from './admin';
export type { AdminPageOptions } from './admin-page';
export { adminPageFiles } from './admin-page';
export { backfillFiles } from './backfill';
export type { FeatureTarget } from './entity';
export { entityFiles } from './entity';
export { guardCode, guardFiles } from './guard';
export type { IslandOptions } from './island';
export { islandFiles } from './island';
export { jobFiles, taskFiles } from './job';
export { CATALOG_ROOT, catalogPath, DEFAULT_LOCALES, resolveLocales } from './locales';
// All three members of the `GeneratedFile` union, not two: the barrel exported the union and the
// foundation variant only, so a consumer could hold a `GeneratedFile` and had no name to narrow it
// to — and `merge` is the discriminant the split exists for.
export type {
  GeneratedFile,
  GeneratedFoundationFile,
  GeneratedJsonFile,
  GeneratedSourceFile,
  NameSet,
} from './naming';
export { camel, kebab, names, pascal, plural, titleKey } from './naming';
export { policyFiles } from './policy';
export type { QueryOptions } from './query';
export { queryFiles } from './query';
export type { ResourceOptions } from './resource';
export { resourceFiles } from './resource';
export { formIslandFiles } from './resource-form-island';
export type { RouteOptions, Surface } from './route';
export { routeFiles } from './route';
export { appFiles } from './scaffold-app';
export { claudeFiles } from './scaffold-claude';
export { claudeAgentFiles } from './scaffold-claude-agents';
export { claudeCommandFiles } from './scaffold-claude-commands';
export { containerFiles } from './scaffold-container';
export { docsFiles, EXECUTABLE_FILES } from './scaffold-docs';
export { entryFiles } from './scaffold-entries';
// The four guards `x new` ships, distinct from `guardFiles` above, which is `x g guard <name>`.
export { scaffoldGuardFiles } from './scaffold-guards';
export { i18nIndex } from './scaffold-i18n';
export { repoFiles } from './scaffold-repo';
export type { SliceModule } from './slice-foundation';
export { sliceFoundation } from './slice-foundation';
