// A plural slice name pluralised again into a table: `x g resource posts` declared
// `entity('postses')`, and `x g query top-posts` — whose plan writes the slice's missing
// `entity.ts` — printed `create top_postses`. Decided on the planned files, so every generator
// that writes an entity is covered the day it starts to, and none that writes none is judged.

import { BadFlagError } from './errors';
import type { Generator } from './generate-kinds';
import type { GeneratedFile } from './templates';
import { kebab, names, singularOf } from './templates/naming';

/** The slice directory of every `entity.ts` this plan would actually write. */
function writtenEntitySlices(
  files: readonly GeneratedFile[],
  exists: (path: string) => boolean,
): readonly string[] {
  return files.flatMap((file) => {
    if (!file.path.endsWith('/entity.ts')) return [];
    // A slice module is written only when the slice lacks it: an `entity.ts` already on disk
    // declares whatever table its author chose, and this run adds no table at all.
    if (file.merge === 'if-absent' && exists(file.path)) return [];
    return [file.path.split('/').at(-2) ?? ''];
  });
}

/**
 * Refuses a plan that writes an `entity.ts` into a slice whose name is already plural. The fix
 * names the singular where the plural came from: the generator's name, or `--feature`.
 */
export function refusePluralTable(
  files: readonly GeneratedFile[],
  kind: Generator,
  name: string,
  feature: string | undefined,
  exists: (path: string) => boolean,
): void {
  for (const slice of writtenEntitySlices(files, exists)) {
    const singular = singularOf(slice);
    if (singular === undefined) continue;
    const fromFeature = feature !== undefined && kebab(feature) === slice;
    const word = fromFeature ? feature : name;
    throw new BadFlagError({
      flag: fromFeature ? 'feature' : 'name',
      command: `g ${kind}`,
      reason: `"${word}" is already plural, and the entity this run writes pluralises it again for its table — "${names(slice).table}"`,
      fix: fromFeature
        ? ['x g', kind, name, '--feature', singular].join(' ')
        : ['x g', kind, singular].join(' '),
    });
  }
}
