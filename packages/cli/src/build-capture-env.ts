// The one name `x build --no-capture` and the static export agree on. Its own module so `x build`
// reads it without loading the export's image and card writers.

/**
 * How `x build --no-capture` reaches the app's own `prerender.ts`, which `x build` spawns and which
 * calls `prerenderSite` with no flag of its own: `off` stamps the card tags and takes no picture.
 * An env var, not an argv flag, so every app's existing `prerender.ts` honours it unedited.
 */
export const BUILD_CAPTURE_ENV = 'ULTIMATE_BUILD_CAPTURE';
