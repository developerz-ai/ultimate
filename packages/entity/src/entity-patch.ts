// Single responsibility: a patch judged by the columns it names, with the same issues `$parse`
// raises for a whole row. Absent stays absent: a patch fills no default, or `update(id, { a })`
// would rewrite every column it did not name.

import { invariantViolated } from './errors';
import { copyRow } from './sealed';
import type { AnyColumn } from './types';

/**
 * The patch, each named column parsed. A property present with `undefined` is absent, the reading
 * `namedColumns` and `bindValues` both give it. `copyRow`, because a row passed back whole keeps
 * its server-only (sealed) properties: they are named by own key, enumerable or not, and parsed
 * like the rest. A key no column declares stays for the statement builder's own refusal, and an
 * empty patch reaches `X_PATCH_EMPTY` as it did.
 */
export const parseEntityPatch = <Patch>(
  name: string,
  columns: Readonly<Record<string, AnyColumn>>,
  patch: Patch,
): Patch => {
  if (typeof patch !== 'object' || patch === null) return patch;
  const parsed = copyRow(patch as object);
  for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(parsed))) {
    const column = Object.hasOwn(columns, property) ? columns[property] : undefined;
    const value: unknown = descriptor.get === undefined ? descriptor.value : descriptor.get();
    if (column === undefined || value === undefined) continue;
    if (value === null) {
      if (column.$meta.notNull) {
        throw invariantViolated(name, property, 'is required and has no default');
      }
      continue;
    }
    const { enumerable } = descriptor;
    Object.defineProperty(parsed, property, {
      value: column.$parse(value),
      enumerable: enumerable === true,
      writable: true,
      configurable: true,
    });
  }
  return parsed as Patch;
};
