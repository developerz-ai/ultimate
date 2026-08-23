/**
 * The BUILD-TIME half of `@ultimat3/render` — the loaders and the route → bytes pipeline — split
 * off because `css-modules.ts` imports `node:url`, whose browser polyfill exports neither name it
 * asks for: one barrel carrying both halves could not be bundled for a browser at all (axiom 6).
 * Disjoint from `@ultimat3/render` by construction, which `server.test.ts` checks.
 */

import { installRenderLoader } from './module-loader';

// A side effect on import, deliberately, and the reason this barrel is named in `sideEffects`: a
// Bun plugin only transforms modules loaded AFTER it, so the install has to happen before any
// `.tsx` route or `.scss` module is imported. It lives on THIS barrel rather than on
// `@ultimat3/render` because the loader is build-time code — a browser bundle that reached it
// would carry `sass` and `node:fs`, which is the defect this split closes.
installRenderLoader();

// ---- scss → css, and the scoped class map every `import styles from` receives -------------------
export type { CompiledStylesheet } from './css-modules';
export { compileStylesheet, isCssModule, isGlobalStylesheet, scopeClasses } from './css-modules';
// ---- the two Bun loaders: `.tsx` → the server JSX factory, `.scss` → css + a class map ----------
export type { Stylesheet } from './module-loader';
export {
  clearStylesheets,
  installRenderLoader,
  loadStylesheet,
  registeredStylesheets,
  stylesFor,
  transformTsx,
} from './module-loader';
// ---- the render pipeline: one entry point per mode ----------------------------------------------
export type { RenderHtmlOptions } from './render-html';
export { ROOT_ELEMENT_ID, renderComponent, renderToHtml } from './render-html';
export type {
  IsrController,
  IsrControllerOptions,
  IsrEntry,
  IsrRenderFn,
  IsrServeResult,
  IsrState,
  IsrStore,
  MemoryIsrStoreOptions,
} from './render-isr';
export {
  createIsrController,
  DEFAULT_ISR_MAX_ENTRIES,
  ISR_LOCALE_PARAM,
  invalidateAndRevalidate,
  isrKey,
  memoryIsrStore,
} from './render-isr';
export type { SsrOptions, SsrRenderFn, SsrRenderInput } from './render-ssr';
export { renderSsr, ssrHeaders } from './render-ssr';
export type { StaticArtifact, StaticBuildOptions, StaticRenderFn } from './render-static';
export {
  assertNoPerRequestState,
  contentHash,
  enumeratePrerender,
  fillPath,
  renderStatic,
  staticHeaders,
  staticResult,
} from './render-static';
export type { StreamHole, StreamOptions, StreamPlan } from './render-stream';
export {
  collectStream,
  DEFAULT_HOLE_TIMEOUT_MS,
  holeId,
  holeMarker,
  REVEAL_SCRIPT,
  renderStreamHtml,
  revealChunk,
  streamResult,
} from './render-stream';
