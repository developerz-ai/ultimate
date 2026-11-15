// Single responsibility: one keyset key's value as the cursor carries it — present, or NULL —
// and back. The tag scheme is entity's (`entity/src/cursor.ts`), replicated: db is tier 1.

import type { KeysetKey } from './keyset-seek';

const ABSENT_MARK = '~';
const PRESENT_MARK = '!';

/**
 * A nullable key's place in the cursor is TAGGED, entity's scheme (`entity/src/cursor.ts`): `~`
 * alone is NULL, `!` prefixes a present value — so a `text` key holding `~` is never read as
 * absent. A not-null key is carried bare, as it was before nullable keys existed.
 */
export const encodePart = (key: KeysetKey | undefined, value: string | null): string => {
  if (key?.nullable !== true) return value ?? '';
  return value === null ? ABSENT_MARK : `${PRESENT_MARK}${value}`;
};

export const decodePart = (key: KeysetKey, part: unknown): string | null | undefined => {
  if (typeof part !== 'string') return undefined;
  if (key.nullable !== true) return part;
  if (part === ABSENT_MARK) return null;
  return part.startsWith(PRESENT_MARK) ? part.slice(PRESENT_MARK.length) : undefined;
};
