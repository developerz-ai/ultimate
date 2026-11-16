// The one reading the credential rows share: GitHub refused the token (HTTP 403) — a token that may
// not read repository secrets or variables is no answer about them, so such a row is no verdict
// that names its command for an admin, never a green and never the whole checkup refused.

/** gh prints `HTTP 403` on a refused token, whatever the subcommand: the message is the signal. */
export const isForbidden = (output: string): boolean => /\bHTTP 403\b/.test(output);

/** The reason an unverdicted credential row gives when its token was refused. */
export const forbiddenReason = (what: string): string =>
  `this token may not read ${what} (HTTP 403) — unknown, never filed: a repository admin runs the fix`;
