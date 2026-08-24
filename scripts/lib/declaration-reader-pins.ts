// The waiver table under `scripts/declaration-readers.ts`: declaration keys that nothing in
// `packages/*/src` reads and that are kept anyway, each with the sentence saying who reads it.
// Data only — the rule owns what it does with these.
//
// IT STARTS EMPTY, and that is the measurement rather than an aspiration: 176 leaf keys across 20
// declaration roots, and the only two the scan reported were `RouteBudget.cls` and `.tbt`, which
// were DELETED rather than pinned. A rule that enforces outright is what the ratchet shape is for
// when the sweep lands first — `scripts/flight-copies.ts` and `scripts/dead-docs-host.ts` are the
// two siblings pinned at zero for the same reason.
//
// WHY A SENTENCE AND NEVER A BARE ENTRY. Every row here is a claim that a key nothing reads still
// does something — because an APP reads it, or a provider does. "Pinned" with no sentence is the
// waiver axiom 3 refuses, so a blank reason does not hold the key: the rule reports it anyway and
// says the pin is missing its reason. Same rule as `FLOOR_ABOVE` in `scripts/lib/tiers.ts`.
//
// Shrink it with `bun run scripts/declaration-readers.ts --unpin <leaf>[,<leaf>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const DECLARATION_PINS_FILE = 'scripts/lib/declaration-reader-pins.ts';

export interface DeclarationReaderPin {
  /** Who reads it, named. Never "false positive", never blank. */
  readonly reason: string;
}

export const DECLARATION_READER_PINS: Readonly<Record<string, DeclarationReaderPin>> = {};

/** Whether this key is waived — a pin whose reason is blank waives nothing. */
export const declarationReaderPinnedFor = (
  leaf: string,
  pins: Readonly<Record<string, DeclarationReaderPin>> = DECLARATION_READER_PINS,
): boolean => Object.hasOwn(pins, leaf) && (pins[leaf]?.reason ?? '').trim().length > 0;

/** A row that exists and says nothing: reported as unread, with the missing sentence named. */
export const declarationReaderPinIsBlank = (
  leaf: string,
  pins: Readonly<Record<string, DeclarationReaderPin>> = DECLARATION_READER_PINS,
): boolean => Object.hasOwn(pins, leaf) && (pins[leaf]?.reason ?? '').trim().length === 0;

/**
 * The edit `X_DECLARATION_READER_PIN_STALE` names, performed: drop each named key's row. Returns
 * what it changed, so the caller can say "nothing to drop" rather than reporting a write it never
 * made.
 */
export async function applyDeclarationReaderUnpin(
  root: string,
  leaves: readonly string[],
  stale: readonly string[],
): Promise<readonly string[]> {
  const path = `${root}/${DECLARATION_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const dropped: string[] = [];
  for (const leaf of leaves) {
    if (!stale.includes(leaf)) continue;
    // `RegExp.escape`, never the raw key: a dotted leaf name is regex syntax, and `.` matching any
    // character deletes a NEIGHBOURING row.
    const entry = new RegExp(
      `^\\s*(['"]?)${RegExp.escape(leaf)}\\1:\\s*\\{[\\s\\S]*?\\n\\s*\\},\\n`,
      'm',
    );
    if (!entry.test(text)) continue;
    text = text.replace(entry, '');
    dropped.push(leaf);
  }
  if (dropped.length > 0) await Bun.write(path, text);
  return dropped;
}
