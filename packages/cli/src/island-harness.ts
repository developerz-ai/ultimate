// The harness document: one island, one state, one theme, mounted over the SEAM the framework
// already has — `data-x-entry` for the chunk, `data-x-props` for the props, and
// `@ultimat3/render`'s own hydration runtime to boot it. A second mounting mechanism here would be
// a picture of something no page ever renders.

// why: no Bun native takes a path apart; the surface is a segment of an app-root-relative path.
import { basename } from 'node:path';
import type { IslandDirective, Surface } from '@ultimat3/render';
import {
  emitIslandAttributes,
  emitIslandProps,
  hydrateRuntime,
  islandModuleId,
  SURFACES,
} from '@ultimat3/render';
import { stylesFor } from '@ultimat3/render/server';
import type { IslandShotTarget, IslandState } from '@ultimat3/testing';
import { harnessScript } from './island-harness-script';

/** Where the harness lives in `x dev`'s own namespace, so no app route can shadow it. */
export const ISLAND_HARNESS_PATH = '/_x/island';

/**
 * `idle`, and not because the picture should wait: it is the only strategy whose runtime boots an
 * island nothing has scrolled to or clicked, and reusing a shipped strategy is what keeps the
 * `data-x-mounted` / `data-x-failed` markers — the two facts a picture cannot carry — landing here
 * exactly as they land on a real page.
 */
const HARNESS_STRATEGY = 'idle';

/**
 * `apps/web/app/settings/settings.island.tsx` → `app`. The CSS a document carries is per surface
 * (axiom 6 applied to bytes the browser parses), so a `site/` island photographed against `app/`'s
 * stylesheet would be a picture of styling that page never receives.
 */
export function surfaceOf(island: string): Surface | null {
  const segment = island.split('/')[2];
  return SURFACES.find((surface) => surface === segment) ?? null;
}

/**
 * The frame, and every rule in it is about what a REVIEWER sees. Animations and transitions are
 * off because a picture taken mid-transition is a picture of a moment no user experiences; the
 * caret is invisible because a focused input blinks and two otherwise identical runs then differ.
 * Colours are semantic tokens, never literals — the app's own global layer defines them.
 */
const FRAME_STYLE = `
*,*::before,*::after{animation:none !important;transition:none !important;
scroll-behavior:auto !important;caret-color:transparent !important}
html{background:rgb(var(--color-bg) / 1)}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:rgb(var(--color-bg) / 1)}
#x-shot-frame{padding:var(--space-4, 16px);max-width:100%;box-sizing:border-box}
`.trim();

export interface HarnessPageInput {
  readonly target: IslandShotTarget;
  readonly state: IslandState;
  /** The built chunk's immutable URL — what `data-x-entry` carries and what the runtime imports. */
  readonly entry: string;
}

/**
 * One address, one document, and every address is a FULL PAGE LOAD. Switching islands or states
 * client-side would carry the previous state's fixtures, its resolved resources and its mounted
 * DOM into the next picture, which is the one way a screenshot tool can lie about its own subject.
 */
export function harnessPage(input: HarnessPageInput): string {
  const moduleId = islandModuleId(basename(input.target.island));
  const directive: IslandDirective = {
    islandId: moduleId,
    moduleId,
    strategy: HARNESS_STRATEGY,
    entry: input.entry,
    props: input.state.props,
  };
  const css = stylesFor(surfaceOf(input.target.island));
  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${input.target.theme}">`,
    '<head><meta charset="utf-8">',
    `<title>${input.target.name} · ${input.target.state} · ${input.target.theme}</title>`,
    css.length === 0 ? '' : `<style>${css}</style>`,
    `<style>${FRAME_STYLE}</style>`,
    // Before the body and before every module script, which is the only ordering in which the
    // seal can catch a component's first request.
    `<script>${harnessScript({
      stubs: input.state.routes,
      now: input.target.now,
      timeZone: input.target.timeZone,
    })}</script>`,
    '</head><body>',
    `<div id="x-shot-frame"><div ${emitIslandAttributes(directive)}></div></div>`,
    emitIslandProps(directive),
    hydrateRuntime([directive]),
    '</body></html>',
  ].join('');
}
