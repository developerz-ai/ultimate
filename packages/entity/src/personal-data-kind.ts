// The closed set of personal-data kinds `.personalData(kind)` takes, and its membership test.
// Imports nothing, so `column.ts` (the chain) and `types.ts` (the meta) can both read it without
// a cycle through the readers in `personal-data.ts` — the shape `search.ts` keeps for `.searchable()`.

/**
 * What a marked value IS, so an export and an erase can treat each kind by its own rule: an
 * identifier (a handle, a national id) ties rows to a person; a contact (email, phone, address)
 * reaches one; free text (a bio, a message) may hold either and is read only by a human.
 */
export const PERSONAL_DATA_KINDS = ['identifier', 'contact', 'free-text'] as const;

export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

export const isPersonalDataKind = (value: unknown): value is PersonalDataKind =>
  typeof value === 'string' && (PERSONAL_DATA_KINDS as readonly string[]).includes(value);
