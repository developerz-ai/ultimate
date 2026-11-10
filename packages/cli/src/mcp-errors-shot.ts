// `errors.explain`'s rows for `x shot` and the `ui.*` MCP tools — the capture family, split out of
// `mcp-errors.ts` under the 500-line ceiling. Spread into `CLI_FIXES` there, whose
// `Record<CliErrorCode, string>` is still what makes a code without a row a build error.

import type { CliErrorCode } from './error-codes';

export const SHOT_FIXES = {
  X_SHOT_BROWSER_MISSING:
    'export CHROME_PATH=/usr/bin/google-chrome   # macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; Windows PowerShell: $env:CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
  X_UI_SHOT_ROUTE_UNKNOWN:
    'x routes --json   # then call the ui.* tool with one of its path values',
  X_UI_SHOT_ROUTE_UNBUDGETED:
    "x build --target static --json && x verify --only budgets --json   # after declaring budget: { js: '<n>kb' } in the route file",
  // The four `ui.interact` refusals. None can be repaired by a command — each is a change to the
  // step list the agent sends — so each names the command that SHOWS what a valid resend needs.
  X_UI_INTERACT_STEPS_INVALID:
    'x help shot --json   # then resend ui.interact with at most 12 one-key steps, type.text under 500 chars and wait under 5000 ms',
  X_UI_INTERACT_SECRET_FIELD:
    'x shot --all-islands --json   # or --island <name>: a declared state renders the filled form without the secret ever being typed',
  X_UI_INTERACT_LEFT_APP:
    'x routes --json   # then resend ui.interact with steps that stay on one of its paths',
  X_UI_INTERACT_STEP_FAILED:
    'x routes --json   # then run ui.inspect on the route first and copy a selector it reports with count >= 1',
  X_SHOT_HOST_REFUSED: 'x shot /route --allow-hosts cdn.example.com --json',
  X_SHOT_ELEMENT_MISSING:
    'x routes --json   # then run ui.inspect on the route first and copy a selector it reports with count >= 1',
  X_SHOT_ELEMENT_UNREADY:
    'x routes --json   # then run ui.inspect on the route first and copy a selector it reports with count >= 1',
  X_SHOT_KEY_INVALID: 'x help shot --json   # a chord is modifiers then one key: Meta+K',
  // The three `ui.diff` codes. Every capture it can compare was written by `x shot` or a `ui.*`
  // tool under `.x/shot/`, so the runnable half is the command that writes one there.
  X_UI_DIFF_PATH_OUTSIDE:
    'x shot / --json   # then pass the image path it answers, relative to the app root: ui.diff reads .x/shot/ and nothing else',
  X_UI_DIFF_FILE_MISSING:
    'x shot / --json   # then diff the image path it answers; a capture ui.shot wrote is listed in its own answer',
  X_UI_DIFF_SIZE_MISMATCH:
    'x shot / --json   # photograph both captures at one viewport with one fullPage setting, then diff those two',
  // The four island-capture codes. Each one's real repair is an edit to the app's own states file
  // or component, which no command can perform — so each names the command that REPRODUCES it with
  // the file and the reason attached, which is the runnable half.
  X_SHOT_ISLAND_STATES_EMPTY:
    'x help shot --json   # then export the manifest from the states file the cause names',
  X_SHOT_ISLAND_UNPHOTOGRAPHABLE:
    'x help shot --json   # the cause names the assertion that did not hold; --settle buys the slow ones more time',
  X_SHOT_ISLAND_UNSTUBBED_REQUEST:
    'x help shot --json   # the cause lists every request the state must answer under routes',
  X_SHOT_ISLAND_MISSING:
    'x help shot --json   # every absent picture carries its own named refusal in the run above',
} as const satisfies Partial<Record<CliErrorCode, string>>;
