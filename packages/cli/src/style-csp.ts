// Every inline `<style>` body a served process can still put in a document, as the `style-src`
// sources that admit it. The caller names them, because the caller is what knows which documents
// it mounted.
//
// The app's OWN CSS is no longer among them, `As of 2026-09-06`: a surface stylesheet is served as
// a content-hashed file (`style-bundle.ts`) and a same-origin `<link>` is admitted by the `'self'`
// already in `@ultimat3/http`'s `style-src`. This function used to hash `stylesFor(surface)` for
// all four surfaces — 157 kB of CSS hashed at boot to admit a block that is not emitted any more,
// which is a rule describing a document nobody serves. So a production boot (`serve.ts`, which
// passes no extras) now extends `style-src` with nothing at all.

import { cspHashSource } from '@ultimat3/http';

/**
 * Call with the inline bodies THIS process emits. `x dev` passes the `/_x` shell's stylesheet and
 * the screenshot harness's frame style — documents this package renders itself, which no app
 * surface can see.
 */
export function inlineStyleSources(bodies: readonly string[] = []): readonly string[] {
  return [...new Set(bodies.filter((body) => body.length > 0).map(cspHashSource))].sort();
}
