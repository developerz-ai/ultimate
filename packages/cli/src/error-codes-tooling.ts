// The X_* codes of the app tooling commands — `x client`, `x graph` / `x impact`, `x repro` and
// `x explain` — split out of `error-codes.ts` at its 500-line ceiling, as `error-codes-shot.ts`
// was. That file folds these into the CLI's one owned union and registers them in its one call.

/** Codes `x client`, `x graph`, `x impact`, `x repro` and `x explain` declare and own. */
export const CLI_TOOLING_ERROR_CODES = [
  'X_CLIENT_SPEC_UNSUPPORTED',
  'X_CLIENT_STALE',
  'X_CLIENT_EDITED',
  'X_GRAPH_NODE_UNKNOWN',
  'X_CLIENT_SPEC_INVALID',
  'X_REPRO_UNKNOWN',
  'X_REPRO_NOT_REPRODUCED',
  'X_REPRO_CAPTURE_OFF',
  'X_EXPLAIN_PRODUCTION_DATABASE',
] as const;

export type CliToolingErrorCode = (typeof CLI_TOOLING_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_TOOLING_ERROR_TITLES: Readonly<Record<CliToolingErrorCode, string>> = {
  X_CLIENT_SPEC_UNSUPPORTED: 'x client met an OpenAPI construct its compiler refuses',
  X_CLIENT_STALE: 'a generated client is older than the document it was compiled from',
  X_CLIENT_EDITED: 'a generated client file was changed by hand',
  X_GRAPH_NODE_UNKNOWN: 'x graph or x impact was asked about a node the app graph does not hold',
  X_CLIENT_SPEC_INVALID: 'x client was handed a document that is not OpenAPI 3.0 or 3.1',
  X_REPRO_UNKNOWN: 'x repro was given an id nothing holds',
  X_REPRO_NOT_REPRODUCED: 'a written repro test did not fail the way the original did',
  X_REPRO_CAPTURE_OFF: 'x repro was given a request id while failure capture is off',
  X_EXPLAIN_PRODUCTION_DATABASE: 'x explain refused to run on a production database',
};
