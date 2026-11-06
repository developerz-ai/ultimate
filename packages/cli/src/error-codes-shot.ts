// The X_* codes of `x shot` and the dev MCP server's `ui.*` tools — the picture-taking surface —
// split out of `error-codes.ts` at its 500-line ceiling. `error-codes.ts` folds these into the
// CLI's one owned union and registers them in its one call; nothing else imports this file.

/** Codes `x shot` and `ui.shot` / `ui.interact` / `ui.diff` declare and own. */
export const CLI_SHOT_ERROR_CODES = [
  'X_SHOT_BROWSER_MISSING',
  // `ui.shot` (the dev MCP server): a route it will not photograph, and why.
  'X_UI_SHOT_ROUTE_UNKNOWN',
  'X_UI_SHOT_ROUTE_UNBUDGETED',
  // `ui.interact`: the four ways a step list is refused. All four REFUSE rather than trim or skip
  // — a step dropped, a keystroke swallowed or a navigation followed changes what the picture is of.
  'X_UI_INTERACT_STEPS_INVALID',
  'X_UI_INTERACT_SECRET_FIELD',
  'X_UI_INTERACT_LEFT_APP',
  'X_UI_INTERACT_STEP_FAILED',
  // `ui.diff`: the three ways two captures fail to become a comparison. The path gate is what
  // lets a file-reading tool sit under `dev:read` — it reads `.x/shot/` and nothing else.
  'X_UI_DIFF_PATH_OUTSIDE',
  'X_UI_DIFF_FILE_MISSING',
  'X_UI_DIFF_SIZE_MISMATCH',
  // `x shot --island` — one code per way a component's named state fails to become a picture.
  // The last of the four is the one that gates: it is checked against the expansion computed
  // before a browser existed, so a capture loop that swallowed a failure cannot exit 0.
  'X_SHOT_ISLAND_STATES_EMPTY',
  'X_SHOT_ISLAND_UNPHOTOGRAPHABLE',
  'X_SHOT_ISLAND_UNSTUBBED_REQUEST',
  'X_SHOT_ISLAND_MISSING',
  // The raw-CDP shot page's own refusals (`cdp-shot-errors.ts` holds the classes): which host it
  // may open, which element it was pointed at, and which key it was asked to press.
  'X_SHOT_HOST_REFUSED',
  'X_SHOT_ELEMENT_MISSING',
  'X_SHOT_ELEMENT_UNREADY',
  'X_SHOT_KEY_INVALID',
] as const;

export type CliShotErrorCode = (typeof CLI_SHOT_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_SHOT_ERROR_TITLES: Readonly<Record<CliShotErrorCode, string>> = {
  X_SHOT_BROWSER_MISSING: '`x shot` has no browser to launch',
  X_UI_SHOT_ROUTE_UNKNOWN: 'a ui.* tool was asked for a path no route answers',
  X_UI_SHOT_ROUTE_UNBUDGETED: 'a ui.* tool refused a route that declares no budget.js',
  X_UI_INTERACT_STEPS_INVALID: 'a ui.interact step list is over its bounds or malformed',
  X_UI_INTERACT_SECRET_FIELD: 'ui.interact refused to type into a password field',
  X_UI_INTERACT_LEFT_APP: 'a ui.interact step navigated off the dev server origin',
  X_UI_INTERACT_STEP_FAILED: 'a ui.interact step raised a scraping error',
  X_UI_DIFF_PATH_OUTSIDE: 'ui.diff was handed a path that does not resolve inside .x/shot/',
  X_UI_DIFF_FILE_MISSING: 'ui.diff was handed a capture that is not on disk',
  X_UI_DIFF_SIZE_MISMATCH: 'ui.diff was handed two captures of different sizes',
  X_SHOT_ISLAND_STATES_EMPTY: 'an island states file declares no manifest',
  X_SHOT_ISLAND_UNPHOTOGRAPHABLE: 'the island never reached a state worth photographing',
  X_SHOT_ISLAND_UNSTUBBED_REQUEST: 'the island requested something no state stub answers',
  X_SHOT_ISLAND_MISSING: 'a declared island picture is not on disk',
  X_SHOT_HOST_REFUSED: "x shot was asked to open a host outside the run's allow list",
  X_SHOT_ELEMENT_MISSING: 'no element matched the selector before the deadline',
  X_SHOT_ELEMENT_UNREADY: 'the element matched and never became ready to act on',
  X_SHOT_KEY_INVALID: 'a key chord the browser cannot press',
};
