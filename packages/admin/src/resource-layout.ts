// How a resource's fields are ARRANGED: the detail page's sections and the form's groups. One
// normaliser for both, and one rule that makes it safe to declare either — a field named in no
// group falls into a default one, so adding a column to the entity never hides it from a screen.

import { AdminFieldUnsupportedError } from './errors';
import type { AdminField } from './fields';

/** One declared group: a titled run of fields, in the order they are named. */
export interface AdminSectionOptions {
  /** i18n key of the heading. */
  readonly titleKey: string;
  readonly fields: readonly string[];
}

/** The form's spelling of the same thing. One shape, so a detail and its form can share a list. */
export type AdminFormGroupOptions = AdminSectionOptions;

export interface AdminSection {
  /** `null` only for the single group of a resource that declared none: it has no heading. */
  readonly titleKey: string | null;
  readonly fields: readonly AdminField[];
  /** The group the undeclared fields fell into. Drawn last. */
  readonly default: boolean;
}

/** The heading of the default group, when declared groups sit above it. */
export const DEFAULT_SECTION_KEY = 'admin.section.other';

interface Layout {
  readonly entity: string;
  /** `sections` or `formGroups` — what a refusal names. */
  readonly option: 'sections' | 'formGroups';
  /** The fields this layout may arrange, in derived order. */
  readonly fields: readonly AdminField[];
  /** Why a named field that is a column is still not one of `fields`. */
  readonly excluded: string;
}

/**
 * Declared groups in declaration order, then the default group holding every field nobody named —
 * in derived order — when there is one. A name that is not a field of this layout, or that two
 * groups both claim, is refused where it is written.
 */
export function layoutOf(
  layout: Layout,
  declared: readonly AdminSectionOptions[] | undefined,
): readonly AdminSection[] {
  if (declared === undefined || declared.length === 0) {
    return [{ titleKey: null, fields: layout.fields, default: true }];
  }
  const claimed = new Map<string, string>();
  const groups = declared.map((group): AdminSection => {
    const fields = group.fields.map((name) => {
      const field = layout.fields.find((known) => known.name === name);
      const refuse = (cause: string, fix: string): never => {
        throw new AdminFieldUnsupportedError({ entity: layout.entity, field: name, cause, fix });
      };
      if (field === undefined) {
        return refuse(
          `named in ${layout.option} ("${group.titleKey}") and ${layout.excluded}`,
          `remove "${name}" from resources.${layout.entity}.${layout.option} — it may name: ${layout.fields.map((known) => known.name).join(', ')}`,
        );
      }
      const owner = claimed.get(name);
      if (owner !== undefined) {
        return refuse(
          `named in two ${layout.option} groups ("${owner}" and "${group.titleKey}")`,
          `keep "${name}" in one group of resources.${layout.entity}.${layout.option}`,
        );
      }
      claimed.set(name, group.titleKey);
      return field;
    });
    return { titleKey: group.titleKey, fields, default: false };
  });
  const rest = layout.fields.filter((field) => !claimed.has(field.name));
  return rest.length === 0
    ? groups
    : [...groups, { titleKey: DEFAULT_SECTION_KEY, fields: rest, default: true }];
}

/** The fields of one group a form in `mode` draws: a field declared for the other side is left out. */
export function fieldsFor(
  fields: readonly AdminField[],
  mode: 'create' | 'edit',
): readonly AdminField[] {
  const side = mode === 'create' ? 'create' : 'update';
  return fields.filter((field) => field.on === undefined || field.on === side);
}
