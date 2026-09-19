// The dev server's eyes: `ui.shot` (a route), `ui.island` (a component's states), `ui.inspect`
// (DOM, computed-style and accessibility facts for a set of selectors, in ONE navigation) and
// `ui.diff` (two captures the others wrote, compared without a browser). Split
// out of `dev-server.ts` because that file stood at 439 lines against the 500-line ceiling and a
// third `ui.*` literal would have crossed it — the catalog is still one array; `devTools` spreads
// this one in. Every type here is re-exported from `dev-server.ts`, so the CLI and the package
// index import what they always did.
//
// A browser is the expensive half of every call here, which is why `ui.inspect` reads MANY
// selectors per navigation and bounds each answer in the handler: a model that asks for a
// thousand selectors gets twenty and a `truncated: true`, never a thousand navigations.

import type { AnyMcpTool, ToolArgs } from './registry';
import { jsonResult } from './registry';

/**
 * The viewports `ui.shot` names. Named, not free, so two agents (or one agent twice) photograph
 * the same thing and can compare the pictures; `{ width, height }` stays available for the one
 * case a name does not cover.
 */
export const UI_VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;
export type UiViewportName = keyof typeof UI_VIEWPORTS;
export type UiColorScheme = 'light' | 'dark';

export interface UiShotInput {
  /** The route's path — `/dashboard`, `/links/abc123` — never a full URL. */
  readonly route: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * What `prefers-color-scheme` the page sees. Emulated on the page BEFORE navigation, so a
   * capture never depends on the box that took it; an app whose boot script honours a stored
   * choice still wins, because the stored choice is what "explicit" means.
   */
  readonly colorScheme: UiColorScheme;
  readonly fullPage: boolean;
}

/**
 * What a picture is worth: the file, and the verdict beside it. The verdict is the SAME shape
 * `x shot` writes to `verdict.json` — console lines, page errors, network refusals, whether every
 * island mounted — so a picture with a hydration error is a finding, never merely a picture.
 * The PNG is a PATH, never inlined bytes: an agent reads the picture it wants and pays for one.
 */
export interface UiShotResult {
  readonly ok: boolean;
  readonly image: string;
  readonly verdictFile: string;
  readonly verdict: unknown;
}

export interface UiIslandInput {
  /** The island's name as `x shot --island <name>` takes it. */
  readonly island: string;
  /** One declared state, or every state the island declares. */
  readonly state?: string | undefined;
}

export interface UiIslandResult {
  readonly ok: boolean;
  readonly dir: string;
  readonly verdictFile: string;
  readonly verdict: unknown;
}

/**
 * Every bound `ui.inspect` applies, in one place, so the handler (selectors, styles), the in-page
 * probe (matches, text, attrs) and the wire cap (bytes) cannot drift apart. Each one exists
 * because the alternative is unbounded: a `*` selector on a long page is thousands of matches,
 * and a match's `textContent` on `<body>` is the whole document.
 */
export const UI_INSPECT_LIMITS = {
  selectors: 20,
  styles: 32,
  matches: 25,
  textChars: 200,
  attrs: 20,
  bytes: 64 * 1024,
} as const;

/** A computed-style property name as CSS spells it: `color`, `font-size`, never `fontSize`. */
export const STYLE_NAME = /^[a-z][a-z0-9-]*$/;

export interface UiInspectInput {
  readonly route: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly colorScheme: UiColorScheme;
  /** At most `UI_INSPECT_LIMITS.selectors`; the handler trims and says so. */
  readonly selectors: readonly string[];
  /** Computed property names, already filtered to `STYLE_NAME` and at most `.styles` of them. */
  readonly styles: readonly string[];
  /** Read the browser's computed role and name per match. Off by default: one round trip each. */
  readonly a11y: boolean;
  readonly activeElement: boolean;
}

export interface UiInspectBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface UiInspectMatch {
  readonly tag: string;
  /** Whitespace-collapsed `textContent`, at most `UI_INSPECT_LIMITS.textChars`. */
  readonly text: string;
  readonly box: UiInspectBox;
  readonly visible: boolean;
  /** At most `UI_INSPECT_LIMITS.attrs` entries, in document order. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly styles: Readonly<Record<string, string>>;
  /** Present only when `a11y: true` was asked and the driver answered for this match. */
  readonly a11y?: { readonly role: string; readonly name: string } | undefined;
}

export interface UiInspectSelector {
  readonly selector: string;
  /** `false` when `querySelectorAll` threw: a malformed selector is a fact, not a crash. */
  readonly valid: boolean;
  readonly count: number;
  /** More matched than `matches` carries — the in-page cap, or the wire cap dropping them. */
  readonly truncated: boolean;
  readonly matches: readonly UiInspectMatch[];
}

export interface UiInspectActive {
  readonly tag: string;
  readonly id: string;
  readonly role: string;
  readonly name: string;
}

export interface UiInspectIslands {
  readonly declared: number;
  readonly booted: number;
  readonly mounted: number;
  readonly failed: number;
}

export interface UiInspectResult {
  /** The verdict's `ok`, by `ui.shot`'s rule: no console error, no throw, no failed mount, no redirect. */
  readonly ok: boolean;
  readonly route: string;
  readonly finalUrl: string;
  readonly title: string;
  /** `document.documentElement`'s `data-theme`, or `null` when the app sets none. */
  readonly theme: string | null;
  readonly activeElement: UiInspectActive | null;
  /** The same island count `ui.island` reads; `null` when the page answered no probe. */
  readonly islands: UiInspectIslands | null;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly refused: number;
  readonly selectors: readonly UiInspectSelector[];
  readonly image: string;
  readonly verdictFile: string;
  /** Selectors were trimmed, or matches were dropped to fit the wire cap. */
  readonly truncated: boolean;
  /** Style names that failed `STYLE_NAME` or fell past the cap — named, so a typo is visible. */
  readonly droppedStyles: readonly string[];
}

export interface UiDiffInput {
  /** Both paths relative to the app root, and both under `.x/shot/` — the host refuses the rest. */
  readonly before: string;
  readonly after: string;
  /** Per-channel delta as a fraction of 255 above which a pixel counts as changed. */
  readonly threshold: number;
  /** Where to write the diff PNG, relative to the app root; default beside `after`. */
  readonly out?: string | undefined;
}

export interface UiDiffResult {
  readonly ok: true;
  readonly before: string;
  readonly after: string;
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  /** Two decimals. */
  readonly changedPercent: number;
  /** The bounding box of every changed pixel, or `null` when the two captures match. */
  readonly changedBox: UiInspectBox | null;
  /** The written diff PNG's path. */
  readonly diff: string;
}

/** The default `threshold`: a tenth of the channel range, which absorbs a one-level wobble. */
export const UI_DIFF_DEFAULT_THRESHOLD = 0.1;

/** The capability half these four tools need. `DevCapabilities` satisfies it structurally. */
export interface UiHost {
  shotRoute(input: UiShotInput): Promise<UiShotResult>;
  shotIsland(input: UiIslandInput): Promise<UiIslandResult>;
  inspectRoute(input: UiInspectInput): Promise<UiInspectResult>;
  diffShots(input: UiDiffInput): Promise<UiDiffResult>;
}

/** The scopes the `ui.*` tools split across: the browser-launching three, and the one that reads. */
export interface UiScopes {
  readonly test: string;
  readonly read: string;
}

/**
 * An explicit `width`+`height` wins over the name; one of the pair alone is not a viewport and
 * falls back to the name (default `desktop`) rather than to a half-sized frame.
 */
export function viewportOf(args: ToolArgs): { readonly width: number; readonly height: number } {
  const width = args['width'];
  const height = args['height'];
  if (typeof width === 'number' && typeof height === 'number') return { width, height };
  const name = args['viewport'];
  const named = typeof name === 'string' && Object.hasOwn(UI_VIEWPORTS, name) ? name : 'desktop';
  return UI_VIEWPORTS[named as UiViewportName];
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const VIEWPORT_ARGS = {
  viewport: {
    type: 'string',
    enum: Object.keys(UI_VIEWPORTS),
    default: 'desktop',
    description: 'phone 390×844, tablet 820×1180, desktop 1440×900.',
  },
  width: { type: 'integer', minimum: 320, maximum: 3840 },
  height: { type: 'integer', minimum: 320, maximum: 2160 },
  theme: { type: 'string', enum: ['light', 'dark'], default: 'dark' },
} as const;

/**
 * The four `ui.*` tools. The scopes are the dev server's `dev:test` and `dev:read`, passed in to
 * keep this file a leaf; `ui.diff` is the one under `read` — it opens no browser.
 */
export function uiTools(host: UiHost, scopes: UiScopes): readonly AnyMcpTool[] {
  const scope = scopes.test;
  return [
    {
      name: 'ui.shot',
      description:
        'Photograph one route at a named viewport (phone/tablet/desktop) or an explicit size, ' +
        'in light or dark, against the running dev server. Returns the PNG path and the same ' +
        'verdict x shot writes: console, page errors, refused requests, whether every island ' +
        'mounted. Refuses a route with no declared JS budget. Launches a browser.',
      scope,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route path, e.g. /dashboard.' },
          ...VIEWPORT_ARGS,
          fullPage: { type: 'boolean', default: true },
        },
        required: ['route'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const route = typeof args['route'] === 'string' ? args['route'] : '';
        const result = await host.shotRoute({
          route,
          viewport: viewportOf(args),
          colorScheme: args['theme'] === 'light' ? 'light' : 'dark',
          fullPage: args['fullPage'] !== false,
        });
        return { ...jsonResult(result), ...(result.ok ? {} : { isError: true }) };
      },
    },
    {
      name: 'ui.island',
      description:
        'Photograph an island in every state its *.island.states.ts declares (or one state), ' +
        'as x shot --island does: PNGs plus a verdict per state. Launches a browser.',
      scope,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          island: { type: 'string', description: 'Island name, e.g. links-table.' },
          state: { type: 'string', description: 'One declared state id; omit for all.' },
        },
        required: ['island'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const island = typeof args['island'] === 'string' ? args['island'] : '';
        const state = typeof args['state'] === 'string' ? args['state'] : undefined;
        const result = await host.shotIsland({ island, ...(state === undefined ? {} : { state }) });
        return { ...jsonResult(result), ...(result.ok ? {} : { isError: true }) };
      },
    },
    {
      name: 'ui.inspect',
      description:
        'Read DOM, computed-style and accessibility facts for up to ' +
        `${UI_INSPECT_LIMITS.selectors} selectors in ONE navigation of a route: per match the tag, ` +
        'text, bounding box, visibility, attributes, the computed styles you name and (a11y: true) ' +
        'the browser-computed role and name; plus the document title, data-theme, the focused ' +
        'element, the island count, console and page errors. Takes the same PNG and verdict ' +
        'ui.shot does; `ok` is the verdict. Refuses a route with no declared JS budget. Launches ' +
        'a browser.',
      scope,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route path, e.g. /dashboard.' },
          ...VIEWPORT_ARGS,
          selectors: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: `CSS selectors, at most ${UI_INSPECT_LIMITS.selectors}; extras are dropped and truncated: true says so.`,
          },
          styles: {
            type: 'array',
            items: { type: 'string' },
            description: `Computed property names (kebab-case), at most ${UI_INSPECT_LIMITS.styles}; invalid names land in droppedStyles.`,
          },
          a11y: {
            type: 'boolean',
            default: false,
            description: 'Read the computed role and name per match (one round trip per selector).',
          },
          activeElement: { type: 'boolean', default: true },
        },
        required: ['route', 'selectors'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const route = typeof args['route'] === 'string' ? args['route'] : '';
        // Bounded HERE, not in the schema: `validate-args.ts` enforces no `maxItems`, and a bound
        // the catalog cannot state is one the handler must apply and then confess to.
        const wanted = strings(args['selectors']);
        const selectors = wanted.slice(0, UI_INSPECT_LIMITS.selectors);
        const named = strings(args['styles']);
        const valid = named.filter((name) => STYLE_NAME.test(name));
        const styles = valid.slice(0, UI_INSPECT_LIMITS.styles);
        const droppedStyles = named.filter((name) => !styles.includes(name));
        const result = await host.inspectRoute({
          route,
          viewport: viewportOf(args),
          colorScheme: args['theme'] === 'light' ? 'light' : 'dark',
          selectors,
          styles,
          a11y: args['a11y'] === true,
          activeElement: args['activeElement'] !== false,
        });
        const answer: UiInspectResult = {
          ...result,
          truncated: result.truncated || wanted.length > selectors.length,
          droppedStyles,
        };
        return { ...jsonResult(answer), ...(answer.ok ? {} : { isError: true }) };
      },
    },
    {
      name: 'ui.diff',
      description:
        'Compare two PNGs the other ui.* tools wrote (paths relative to the app root, under ' +
        '.x/shot/ only — anything else is refused) pixel by pixel: the changed-pixel count and ' +
        'percentage, the bounding box of the change, and the path of a diff PNG (after faded to ' +
        'a quarter, changed pixels solid red). A pixel is changed when any channel moved by more ' +
        'than threshold × 255; no anti-alias detection. Refuses two sizes. Launches no browser.',
      scope: scopes.read,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          before: {
            type: 'string',
            description: 'Path under .x/shot/, e.g. .x/shot/dashboard/1440x900-dark/page.png.',
          },
          after: { type: 'string', description: 'Path under .x/shot/ of the later capture.' },
          threshold: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            default: UI_DIFF_DEFAULT_THRESHOLD,
            description:
              'Per-channel delta as a fraction of 255 above which a pixel counts as changed.',
          },
          out: {
            type: 'string',
            description: 'Where to write the diff PNG (under .x/shot/); default beside `after`.',
          },
        },
        required: ['before', 'after'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const before = typeof args['before'] === 'string' ? args['before'] : '';
        const after = typeof args['after'] === 'string' ? args['after'] : '';
        const threshold =
          typeof args['threshold'] === 'number' ? args['threshold'] : UI_DIFF_DEFAULT_THRESHOLD;
        const out = typeof args['out'] === 'string' ? args['out'] : undefined;
        const result = await host.diffShots({
          before,
          after,
          threshold,
          ...(out === undefined ? {} : { out }),
        });
        return jsonResult(result);
      },
    },
  ];
}
