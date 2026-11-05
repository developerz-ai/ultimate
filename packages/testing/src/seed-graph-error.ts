// The one refusal the seed graph has: no generated row satisfies a table. Apart from ./errors, which
// owns the code, its title and the one registration, because that catalogue is at its ceiling. Every
// fix names the `defineFactory` to write, since a factory is the only input that beats the graph.

import { renderFixLiteral, UltimateError } from '@ultimat3/core';
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
      fix: `defineFactory(<the ${input.entity} entity>, { defaults: (index, ids) => ({ ${body} }) }), then seedGraph(entities, { factories: { ${name}: thatFactory } })`,
    });
  }
}

export const seedGraphUnsatisfied = (input: SeedGraphUnsatisfiedInput): SeedGraphUnsatisfiedError =>
  new SeedGraphUnsatisfiedError(input);
