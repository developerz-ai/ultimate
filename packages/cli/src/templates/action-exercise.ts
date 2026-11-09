// A generated action's ONE exercise declaration: its entry in `apps/web/exercise.ts`, which `x g`
// inserts (`exercise-entry-edit.ts`) and both runners read — the contract test hands that file's
// export to `.contract({ exercise })`, and `x exercise` re-homes the actor into each tenant it seeds.

import type { ExerciseEntry } from '../exercise-entry-edit';

const ORG = '00000000-0000-4000-8000-000000000002';

/**
 * `../../../exercise` from a directory under the app root (`apps/web/app/post/actions`). Counted
 * off the shared `apps/web/` prefix, which every generated surface sits under.
 */
export function exerciseImportFrom(dir: string): string {
  const prefix = 'apps/web/';
  const depth = dir.startsWith(prefix) ? dir.slice(prefix.length).split('/').length : 0;
  return depth === 0 ? './exercise' : `${'../'.repeat(depth)}exercise`;
}

/** The import line a contract test reads the declarations with. */
export const exerciseImportLine = (dir: string): string =>
  `import { exercise } from '${exerciseImportFrom(dir)}';`;

/**
 * Who the generated-input runs act as: a member holding the slice's grant, in the org every draw
 * is bound to when the policy compares orgs. A grant that cannot be read is the author's to name,
 * so the entry turns the exercise off and says what to write instead. Printed expanded at every
 * level, the shape Biome keeps for an object written over several lines.
 */
export function actionExerciseEntry(
  name: string,
  grant: string | undefined,
  orgRule: boolean,
  feature: string,
): ExerciseEntry {
  if (grant === undefined) {
    return {
      name,
      value: `{\n  off: '${feature}/policy.ts names no one grant: give { actor } holding what it checks',\n}`,
    };
  }
  return memberEntry(name, grant, orgRule ? { org: ORG, bindsInput: true } : {});
}

/**
 * A member holding `grant`; in `org` when given, and with every draw's `orgId` bound to it when
 * `bindsInput` — an action whose input names no org (a create that writes under the actor's) gets
 * the actor's org alone.
 */
export function memberEntry(
  name: string,
  grant: string,
  where: { readonly org?: string; readonly bindsInput?: boolean },
): ExerciseEntry {
  const { org } = where;
  const actor = [
    'actor: userActor({',
    "  id: 'member',",
    ...(org === undefined ? [] : [`  orgId: '${org}',`]),
    `  permissions: ['${grant}'],`,
    '}),',
  ];
  const input =
    org === undefined || where.bindsInput !== true
      ? []
      : [`input: (drawn) => ({ ...drawn, orgId: '${org}' }),`];
  return {
    name,
    value: `{\n${[...actor, ...input].map((line) => `  ${line}`).join('\n')}\n}`,
    imports: [{ name: 'userActor', from: '@ultimat3/core' }],
  };
}
