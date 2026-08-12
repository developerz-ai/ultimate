// Every inline `<style>` body a served process can put in a document, as the `style-src` sources
// that admit it. Read from the stylesheet registry at boot rather than checked in as a constant:
// importing the app's modules IS what fills that registry, so a committed hash would describe a
// stylesheet the document no longer carries — and the CSP would block the framework's own CSS.

import { cspHashSource } from '@ultimat3/http';
import { SURFACES, stylesFor } from '@ultimat3/render';

/**
 * Call AFTER `loadApp`. One hash per distinct body: `stylesFor` is what `dev-render.ts` puts in
 * the tag, per surface, so hashing the same call is the only way the two cannot drift. `extra`
 * carries the documents this package does not render — `/_x`'s shell — because the caller is what
 * knows which of them it mounted.
 */
export function inlineStyleSources(extra: readonly string[] = []): readonly string[] {
  const bodies = [...SURFACES.map((surface) => stylesFor(surface)), ...extra];
  return [...new Set(bodies.filter((body) => body.length > 0).map(cspHashSource))].sort();
}
