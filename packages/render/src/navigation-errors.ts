/**
 * The one refusal a BROWSER can reach in this package — `openModal`'s — apart from `errors.ts` for
 * bytes: that module registers render's whole code table at import, and an island that calls
 * `openModal` must not carry it. `errors.ts` re-exports this class, so it is ONE class wherever it is
 * imported from and `instanceof` agrees across both entries. Without the table loaded, core titles
 * the code from its name; the code, cause and fix are the same either way. Runs nothing at import.
 */

import { UltimateError } from '@ultimat3/core/page';

/** `openModal` was handed something no `#<path>` hash can address. Rejected, never thrown. */
export class NavigationModalPathInvalidError extends UltimateError {
  static readonly code = 'X_NAVIGATION_MODAL_PATH_INVALID' as const;
  constructor(path: string) {
    super({
      code: NavigationModalPathInvalidError.code,
      cause: `openModal(${JSON.stringify(path)}): a modal is addressed by '#<path>', and this is not an absolute path on this origin`,
      fix: "openModal('/runs/new') — the modal route's own path, as its link carries it; never a full URL or a relative one",
    });
  }
}
