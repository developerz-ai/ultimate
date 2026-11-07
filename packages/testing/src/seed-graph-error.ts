// The seed graph's refusals: no generated row satisfies a table, or a writer handed a plan for an
// entity it was not given. Apart from ./errors, which owns the codes, their titles and the one
// registration, because that catalogue is at its ceiling. A row refusal's fix names the
// `defineFactory` to write, since a factory is the only input that beats the graph.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
import './errors';

/** What could not be generated: a column, a rule a row breaks, or a cycle with no nullable edge. */
export interface SeedGraphUnsatisfiedInput {
  readonly entity: string;
  readonly what: string;
  /** The columns the factory has to supply. Empty when no column is to blame (a cycle). */
  readonly columns: readonly string[];
}

const ENTITY_PLACEHOLDER = '<the entity the cause names>';

/** `defaultFor` and `seedGraph` refuse the same way: the row is the app's to describe. */
export class SeedGraphUnsatisfiedError extends UltimateError {
  constructor(input: SeedGraphUnsatisfiedInput) {
    const name = renderFixLiteral(input.entity, ENTITY_PLACEHOLDER);
    const body =
      input.columns.length === 0
        ? '/* every column */'
        : input.columns.map((column) => `${column}: …`).join(', ');
    super({
      code: 'X_SEED_GRAPH_UNSATISFIED',
      cause: `${input.entity}: ${input.what}`,
      fix: `defineFactory(<the ${input.entity} entity>, { defaults: (index, ids) => ({ ${body} }) }), then seedGraph(entities, { factories: { ${name}: thatFactory } }) — for x exercise, defineExercise({}, { factories: { ${name}: thatFactory } }) in apps/web/exercise.ts`,
    });
  }
}

export const seedGraphUnsatisfied = (input: SeedGraphUnsatisfiedInput): SeedGraphUnsatisfiedError =>
  new SeedGraphUnsatisfiedError(input);

/**
 * `entitySeedWriter` met a row whose entity is not in the set it writes through: the plan and the
 * writer were built from two different entity sets. The fix is one set, handed to both.
 */
export class SeedGraphEntityUnknownError extends UltimateError {
  constructor(input: { readonly entity: string; readonly known: readonly string[] }) {
    super({
      code: 'X_SEED_GRAPH_ENTITY_UNKNOWN',
      cause: `the seed plan writes ${renderCauseValue(input.entity)}, and the writer holds only ${renderCauseValue(input.known)}`,
      fix: 'const graph = seedGraph(entities, …); await insertSeedGraph(graph, entitySeedWriter({ entities, … }))   # one entity set for both',
    });
  }
}
