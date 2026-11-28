// The X_* codes of the design-research surface (`x design research`, `x shot --against`) and the
// managed agent kit (`x kit`, the gate's kit check) — split out of `error-codes.ts` at its 500-line
// ceiling, as `error-codes-shot.ts` was. `error-codes.ts` folds these into the CLI's one owned union
// and registers them in its one call; nothing else imports this file.

/** Codes the design-research commands and the agent kit declare and own. */
export const CLI_KIT_ERROR_CODES = [
  'X_DESIGN_URL_REFUSED',
  'X_DESIGN_REFERENCE_UNREACHABLE',
  'X_SHOT_AGAINST_MISSING',
  'X_KIT_DRIFT',
  'X_KIT_SHADOWED',
] as const;

export type CliKitErrorCode = (typeof CLI_KIT_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_KIT_ERROR_TITLES: Readonly<Record<CliKitErrorCode, string>> = {
  X_DESIGN_URL_REFUSED: 'design reference URL refused',
  X_DESIGN_REFERENCE_UNREACHABLE: 'design reference unreachable',
  X_SHOT_AGAINST_MISSING: 'no reference shot to compare against',
  X_KIT_DRIFT: 'agent kit file drifted',
  X_KIT_SHADOWED: 'agent kit name shadowed',
};
