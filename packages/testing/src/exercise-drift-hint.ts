// The override line a drifted primitive's record carries: `name: { input: (drawn) => ({ ...drawn,
// digest: "<must match ^[0-9a-f]{64}$>" }) },` — the field no draw can fill, named and bound,
// rendered by core's one `renderDrawnInput`. No `actor:`: the pass picks one when the entry has none.

import { renderDrawnInput, renderExerciseKey, sampleGapBinding } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Sampler } from './exercise-input';
import { UNBOUND_ID } from './exercise-override-line';

/** `idFields` are the input's id-shaped keys: each wants a real row's id, as the other hints say. */
export function driftOverrideLine(
  name: string,
  schema: StandardSchemaV1,
  sampler: Sampler,
  idFields: readonly string[],
  /** Each id field's seeded value, where the pass bound one: the line binds that row. */
  ids: Readonly<Record<string, string>> = {},
): string {
  const gaps = sampler.sampleGaps(schema);
  const bindings = [
    ...gaps.map((path) => sampleGapBinding(path, sampler.describeSampleGap(schema, path))),
    ...idFields
      .filter((field) => !gaps.includes(field))
      .map((field) => ({ path: field, placeholder: ids[field] ?? UNBOUND_ID })),
  ];
  const input =
    bindings.length === 0
      ? "(drawn) => ({ ...drawn, field: '<a value the refinement accepts>' })"
      : renderDrawnInput(bindings);
  return `${renderExerciseKey(name)}: { input: ${input} },`;
}
