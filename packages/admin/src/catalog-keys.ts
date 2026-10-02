// Every catalog key one declared admin derives — branding, nav, screen titles, resource titles and
// groups, field labels and hints, sections, scopes, computed columns, action labels and their form
// fields. `AdminApp.catalogKeys()` returns it and the CLI's `i18n` step audits it, so the rule that
// draws a key and the rule that asks a catalog for it are one function.

import { actionInputFields } from './action-input';
import { actionLabelKey } from './action-label';
import type { AdminRoute } from './admin';
import type { NavGroup } from './nav';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';
import type { AdminBranding } from './theme';

export interface CatalogKeysInput {
  readonly branding: AdminBranding;
  readonly nav: readonly NavGroup[];
  readonly routes: readonly AdminRoute[];
  readonly resources: readonly AdminResource[];
  readonly globalActions: readonly AdminAction[];
}

/**
 * Not here: an enum option's label (`…field.<name>.option.<value>`), which falls back to the value
 * itself by design (`optionLabel`), and the admin's fixed chrome (`admin.form.save`), which is
 * spelled in this package's own source rather than derived from a declaration.
 */
export function adminCatalogKeys(app: CatalogKeysInput): readonly string[] {
  const keys = new Set<string>([app.branding.nameKey]);
  if (app.branding.logo !== undefined) keys.add(app.branding.logo.altKey);
  for (const group of app.nav) {
    keys.add(group.labelKey);
    for (const item of group.items) keys.add(item.labelKey);
  }
  for (const route of app.routes) keys.add(route.titleKey);
  const action = (declared: AdminAction): void => {
    keys.add(actionLabelKey(declared));
    for (const field of actionInputFields(declared)) keys.add(field.labelKey);
  };
  for (const declared of app.globalActions) action(declared);
  for (const resource of app.resources) {
    keys.add(resource.titleKey);
    keys.add(resource.group);
    for (const field of [...resource.fields, ...resource.secretFields]) {
      keys.add(field.labelKey);
      if (field.hintKey !== undefined) keys.add(field.hintKey);
    }
    for (const section of [...resource.sections, ...resource.formGroups]) {
      if (section.titleKey !== null) keys.add(section.titleKey);
    }
    for (const scope of resource.scopes) keys.add(scope.labelKey);
    for (const column of resource.columns) keys.add(column.labelKey);
    for (const declared of resource.actions) action(declared);
  }
  return [...keys].sort();
}
