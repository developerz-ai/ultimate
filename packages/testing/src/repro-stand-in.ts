// Single responsibility: a value for every field a failure bundle masked. The bundle never holds a
// secret, so a replay needs one that the schema accepts: the masked paths are filled from a seeded
// `arbitrary()` value of the same schema (input), or from the column's own candidates (a row).

import { REDACTED, uuidV7 } from '@ultimat3/core';
import type { EntityCore } from '@ultimat3/entity';
import { arbitrary } from '@ultimat3/schema/sample';
import { candidatesFor, type SeedColumn } from './seed-graph-values';

/** The seed every stand-in draws from: the same bundle, the same replay. */
const STAND_IN_SEED = 0x5eed;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every `REDACTED` leaf of `value` replaced by the leaf at the same place in `sample`. */
function fill(value: unknown, sample: unknown): unknown {
  if (value === REDACTED) return sample;
  if (Array.isArray(value)) {
    const items = Array.isArray(sample) ? sample : [];
    return value.map((entry, index) => fill(entry, items[index] ?? items[0]));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: fill(entry, isRecord(sample) ? sample[key] : undefined),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The input with every masked field replaced by a value `schema` accepts. */
export function inputStandIn(schema: unknown, input: unknown, masked: readonly string[]): unknown {
  if (masked.length === 0) return input;
  // `arbitrary` reads the schema's IR; a schema without one yields `{}`, and the replay says so.
  const sample = arbitrary(schema as Parameters<typeof arbitrary>[0], {
    seed: STAND_IN_SEED,
    run: 0,
  });
  return fill(input, sample);
}

/** The row with every masked column replaced by the first value that column stores. */
export function rowStandIn(
  entity: EntityCore<unknown>,
  row: Readonly<Record<string, unknown>>,
  masked: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  const columns = entity.$columns as Readonly<Record<string, SeedColumn>>;
  for (const [position, property] of masked.entries()) {
    const column = columns[property];
    if (column === undefined) continue;
    const [first] = candidatesFor(property, column, {
      ordinal: 1,
      canary: '5eed',
      position,
      uuid: () => uuidV7(),
    });
    out[property] = first;
  }
  return out;
}
