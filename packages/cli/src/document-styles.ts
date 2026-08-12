// One question the gate asks of what a render actually emits: does the document carry its global
// style layer? Every rule `@ultimat3/ui` emits reads a custom property — `background:rgb(var(
// --color-bg)/1)`, `padding:var(--space-8)` — so CSS with no `:root` definitions is a document the
// browser drops every one of those declarations from, byte-for-byte identical to a working page
// apart from the styling nobody sees missing. A silent failure is exactly what axiom 3 exists for.

import type { Surface } from '@ultimat3/render';
import { routeEntries, stylesFor } from '@ultimat3/render';
import type { Finding } from './output';

/** The stylesheet an app is expected to own, named in the fix so it is one edit, not a hunt. */
export const APP_GLOBAL_STYLESHEET = 'shared/global.scss';
export const APP_GLOBAL_MODULE = 'shared/global.ts';

/**
 * A custom property DEFINED at the document root. `var(--color-bg)` is a *use* and cannot match —
 * there is no colon after the name — which is the whole distinction the check turns on: the broken
 * document was full of uses and had not one definition.
 */
const ROOT_CUSTOM_PROPERTY = /:root[^{}]*\{[^{}]*--[\w-]+\s*:/;

export const definesRootCustomProperties = (css: string): boolean => ROOT_CUSTOM_PROPERTY.test(css);

export interface SurfaceDocument {
  readonly surface: Surface;
  /** Exactly the CSS `dev-render.ts` would inline into a document on this surface. */
  readonly css: string;
}

/**
 * Every surface that renders a document, with the CSS one would carry. `api/` is excluded because
 * it emits no document at all — a surface with nothing to style is not a surface missing its
 * tokens. Read from render's own registry, filled when the CLI loaded the app: a second walk of
 * the app's stylesheets here would be a second answer to "what does this document contain".
 */
export function documentSurfaces(): readonly SurfaceDocument[] {
  const surfaces = new Set(routeEntries().map((entry) => entry.surface));
  surfaces.delete('api');
  return [...surfaces]
    .sort()
    .map((surface) => ({ surface, css: stylesFor(surface) }) satisfies SurfaceDocument);
}

export function checkDocumentStyles(documents: readonly SurfaceDocument[]): readonly Finding[] {
  return documents
    .filter((document) => !definesRootCustomProperties(document.css))
    .map((document) => ({
      code: 'X_STYLES_GLOBAL_MISSING',
      cause: `a ${document.surface}/ document carries ${document.css.length} characters of CSS and defines no :root custom properties, so every var(--color-*) and var(--space-*) in it resolves to nothing`,
      fix: `add apps/web/${APP_GLOBAL_STYLESHEET} containing \`@use '@ultimat3/ui/global.scss';\` and apps/web/${APP_GLOBAL_MODULE} containing \`import './global.scss';\``,
      docs: 'https://ultimate.dev/errors/X_STYLES_GLOBAL_MISSING',
      at: `apps/web/${APP_GLOBAL_STYLESHEET}`,
    }));
}
