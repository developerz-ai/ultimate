// `time.detect`'s boot fact: the zone script's tag and the CSP source that admits exactly it, or
// nothing for an app that left detection off. Composed into `app/` documents only, by the one
// head both boots spread (`clientScriptHeads`), so `site/` never pays for it (axiom 6).

import type { AppTimeConfig } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { renderHead, zoneScript, zoneScriptBody } from '@ultimat3/render';

export interface ZoneBoot {
  /** The rendered `<script>`, for the `app/` document head. */
  readonly head: string;
  /** The `script-src` source that admits exactly that tag's body. */
  readonly cspSource: string;
}

/** Tag and hash from ONE body, as `themeBoot` does. `undefined` unless the app said `detect`. */
export function zoneBoot(time: AppTimeConfig | undefined): ZoneBoot | undefined {
  if (time?.detect !== true) return undefined;
  return { head: renderHead([zoneScript()]), cspSource: cspHashSource(zoneScriptBody()) };
}
