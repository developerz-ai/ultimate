// Which titles module a new code lands in, for a package that keeps two: the page's
// (`error-titles.ts`, in every island chunk) and the server's (`error-titles-server.ts`, in none).
// Only the author knows whether a browser can raise or receive the code, so the choice is a flag,
// exactly one of two, required where the split exists and refused where it does not.

import { flagBool, parseScriptArgs } from './args';
import { ScriptError } from './script-error';

/** `any`: a package with one titles module — the planner's usual search decides. */
export type TitlesRealm = 'any' | 'browser' | 'server-only';

export const serverTitlesFile = (pkg: string): string =>
  `packages/${pkg}/src/error-titles-server.ts`;

const RERUN =
  "bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --cause '…' --fix '…' --browser   # a page can raise or receive it; or --server-only: only a server process can";

/** Decided before any write; `hasServerTitles` is whether `serverTitlesFile(pkg)` exists. */
export function titlesRealm(
  pkg: string,
  argv: readonly string[],
  hasServerTitles: boolean,
): TitlesRealm {
  const args = parseScriptArgs(argv);
  const browser = flagBool(args, 'browser');
  const serverOnly = flagBool(args, 'server-only');
  if (!hasServerTitles) {
    if (!browser && !serverOnly) return 'any';
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `@ultimat3/${pkg} keeps one titles module (no ${serverTitlesFile(pkg)}), so its codes take neither --browser nor --server-only`,
      fix: "bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --cause '…' --fix '…'   # the same run, without --browser and --server-only",
    });
  }
  if (browser === serverOnly) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `@ultimat3/${pkg} titles page codes and server-only codes in two modules, so a new code needs exactly one of --browser and --server-only, and this run gave ${browser ? 'both' : 'neither'}`,
      fix: RERUN,
    });
  }
  return browser ? 'browser' : 'server-only';
}
