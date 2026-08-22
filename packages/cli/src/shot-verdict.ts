// What a shot CLAIMS, and what it refuses to claim: the verdict `x shot` writes beside the
// picture, built from plain values so every rule here is testable with no browser, no dev server
// and no `ParsedArgs` — the `cmd-jobs.ts` / `jobs-report.ts` split, repeated.

import { probeImage } from '@ultimat3/core';
import { ISLAND_FAILED_ATTRIBUTE, ISLAND_MOUNTED_ATTRIBUTE } from '@ultimat3/render';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t, validate } from '@ultimat3/schema';
import type { ConsoleLine, NetworkEntry, PageError } from '@ultimat3/scraping';
import { msg } from './messages';
import type { JsonValue } from './output';

/**
 * The one expression that counts islands, and it counts TWO different facts because they are two
 * different facts. `data-x-island` is emitted by `emitIslandAttributes` for every island on the
 * page including `hydrate: 'never'`, so its presence means "the server rendered an island here"
 * and nothing about the client. `el.__x` is the boot promise `hydrateRuntime`'s prelude assigns
 * (`el.__x=import(e).then(…)`), so it means "the runtime asked for this island's chunk" — still
 * not "mount() resolved", which nothing in the DOM records today.
 *
 * An expression, never a closure: `CdpPageLike.evaluate` takes the string form only.
 */
/** Every key this command renders. `msg()` answers `⟦key⟧` for a miss, which no build can see. */
export const SHOT_MESSAGE_KEYS = [
  'cli.shot.ok',
  'cli.shot.errors',
  'cli.shot.redirected',
  'cli.shot.picture',
  'cli.shot.verdict',
  'cli.shot.server.booted',
  'cli.shot.server.reused',
  'cli.shot.canvas',
  'cli.shot.canvasUnreadable',
  'cli.shot.islands',
  'cli.shot.islandsUnknown',
  'cli.shot.islandFailed',
  'cli.shot.network',
  'cli.shot.console',
  'cli.shot.threw',
  'cli.shot.pageError',
  'cli.shot.blind.status',
] as const;

/**
 * Four facts, not one, because they are genuinely different and conflating them is what makes a
 * screenshot tool lie. `declared` is server-rendered and says nothing about the client.
 * `booted` means the runtime CALLED `import()` — set before `mount()` settles, and legitimately
 * absent for a `visible` or `interaction` island nothing has scrolled to or clicked. `mounted` and
 * `failed` are the outcome, marked by the prelude itself when the mount promise settles.
 *
 * The attribute names are INTERPOLATED from `@ultimat3/render`'s own exports rather than typed
 * here: this probe and the runtime that writes the markers have to agree, and a second spelling of
 * `data-x-mounted` would read as "no island mounted" — a clean-looking answer that is wrong.
 */
export const ISLAND_PROBE =
  '(function(){var els=document.querySelectorAll("[data-x-island]");var by={};var booted=0;' +
  'var mounted=0;var failed=0;var failures=[];' +
  'for(var i=0;i<els.length;i+=1){var el=els[i];' +
  'var s=el.getAttribute("data-x-hydrate")||"unknown";by[s]=(by[s]||0)+1;' +
  'if(el.__x!==undefined)booted+=1;' +
  `if(el.hasAttribute("${ISLAND_MOUNTED_ATTRIBUTE}"))mounted+=1;` +
  `if(el.hasAttribute("${ISLAND_FAILED_ATTRIBUTE}")){failed+=1;failures.push({` +
  'island:el.getAttribute("data-x-island")||"",' +
  `message:el.getAttribute("${ISLAND_FAILED_ATTRIBUTE}")||''});}}` +
  'return{declared:els.length,booted:booted,mounted:mounted,failed:failed,' +
  'byStrategy:by,failures:failures};})()';

export interface IslandCount {
  /** `[data-x-island]` in the served DOM — server-rendered, whatever the client then did. */
  readonly declared: number;
  /** Islands whose chunk the hydration runtime asked for. See `ISLAND_PROBE` for the distance. */
  readonly booted: number;
  /** Islands whose `mount()` RESOLVED. This is the one that answers "does the page work". */
  readonly mounted: number;
  /** Islands whose `mount()` REJECTED — the case a picture can never show. */
  readonly failed: number;
  /** `data-x-hydrate` value → count, so a `never` island is never read as a failure to boot. */
  readonly byStrategy: Readonly<Record<string, number>>;
  /** Which island threw, and what it said. Empty when `failed` is 0. */
  readonly failures: readonly IslandFailure[];
}

export interface IslandFailure {
  readonly island: string;
  readonly message: string;
}

const islandProbeSchema: StandardSchemaV1<unknown, IslandCount> = t.object({
  declared: t.number,
  booted: t.number,
  mounted: t.number,
  failed: t.number,
  byStrategy: t.record(t.number),
  failures: t.array(t.object({ island: t.string, message: t.string })),
}) as unknown as StandardSchemaV1<unknown, IslandCount>;

/**
 * `evaluate()` answers `unknown` on every driver — a page can return anything at all — so the
 * probe's result is PARSED and never cast. `null` for anything that does not fit, because a
 * malformed probe must not be able to take a capture down after the picture was already taken.
 */
export function parseIslandProbe(value: unknown): IslandCount | null {
  const result = validate(islandProbeSchema, value);
  return result.issues === undefined ? result.value : null;
}

export interface ShotCanvas {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

/**
 * The picture's own pixel size, read from the header bytes by `@ultimat3/core`'s one image probe —
 * never a viewport number the tool asked for and cannot prove it got. `null` when the bytes are
 * not a decodable image, which is a fact worth reporting rather than an exception worth throwing:
 * the offline drivers answer a PNG signature with no IHDR behind it.
 */
export function canvasOf(bytes: Uint8Array): ShotCanvas | null {
  try {
    const info = probeImage(bytes);
    return { width: info.width, height: info.height, format: info.format };
  } catch {
    return null;
  }
}

export interface ShotInput {
  readonly route: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly server: 'booted' | 'reused';
  readonly capturedAt: string;
  /** The picture's filename, beside the verdict — a sibling, so the pair moves as one directory. */
  readonly screenshot: string;
  readonly bytes: Uint8Array;
  readonly console: readonly ConsoleLine[];
  /**
   * Uncaught exceptions, which are NOT console lines: a throw calls no console method, so a page
   * whose island exploded can have `console: []`. This is the field the whole command was for —
   * "a picture cannot tell you the island threw".
   */
  readonly pageErrors: readonly PageError[];
  /** Page errors the ring evicted, so `pageErrors.length` reads as a floor and not a total. */
  readonly pageErrorsDropped: number;
  readonly network: readonly NetworkEntry[];
  readonly networkDropped: number;
  /** `null` when the probe could not run or did not parse. Never a zero standing in for unknown. */
  readonly islands: IslandCount | null;
}

export interface ShotVerdict extends ShotInput {
  readonly ok: boolean;
  /** The route asked for is not the document photographed. An `auth: 'required'` route's default. */
  readonly redirected: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly canvas: ShotCanvas | null;
  readonly refused: number;
  /** What this verdict cannot see, stated every time — a `0` whose blind spots are named. */
  readonly blind: readonly string[];
}

/**
 * What a shot is blind to, each naming the mechanism rather than apologising. Constant because
 * these are properties of the browser port, not of a run — and in the artifact because `errors: 0`
 * read without them is a claim the tool cannot support.
 *
 * It was three. `pageErrors` and `hydration` both left on 2026-08-21, when `@ultimat3/scraping`
 * learned to capture `pageerror` and the hydration prelude learned to mark a mount's outcome. A
 * blind spot is worth stating while it is true and worth DELETING the moment it is not: a stale
 * one teaches an agent to distrust an answer the tool can now give.
 */
export const BLIND_SPOTS = ['cli.shot.blind.status'] as const;

const levelCount = (lines: readonly ConsoleLine[], level: ConsoleLine['level']): number =>
  lines.filter((line) => line.level === level).length;

/**
 * `ok` is four conditions, and every one is something a picture cannot show: nothing on the page
 * logged an error, nothing THREW, no island's `mount()` REJECTED, and the document photographed is
 * the route that was asked for.
 *
 * The throw is its own clause rather than folded into `errors` because an uncaught exception calls
 * no console method — a page whose island died can log nothing at all, and `errors === 0` would
 * then pass it. A rejected mount is a third silent one and was read by NOTHING until 2026-08-22:
 * the prelude pays 129 B an island to write `data-x-failed`, the probe counted it into the
 * artifact, and every island on a page could reject while the run reported "clean". `?? 0` keeps
 * an uncounted probe (`null`) out of the verdict — "not counted" is not "none failed".
 * A redirect is a failure of the CAPTURE rather than of the app: an agent that
 * photographs the sign-in page and files "the island did not mount" is the outcome this prevents.
 */
export function buildVerdict(input: ShotInput): ShotVerdict {
  const errors = levelCount(input.console, 'error');
  return {
    ...input,
    ok:
      errors === 0 &&
      input.pageErrors.length === 0 &&
      (input.islands?.failed ?? 0) === 0 &&
      input.requestedUrl === input.finalUrl,
    redirected: input.requestedUrl !== input.finalUrl,
    errors,
    warnings: levelCount(input.console, 'warn'),
    canvas: canvasOf(input.bytes),
    refused: input.network.filter((entry) => entry.refused !== undefined).length,
    blind: BLIND_SPOTS.map((key) => msg(key)),
  };
}

const consoleJson = (lines: readonly ConsoleLine[]): JsonValue =>
  lines.map((line) => ({ level: line.level, text: line.text, at: line.at }));

const islandJson = (islands: IslandCount | null): JsonValue =>
  islands === null
    ? null
    : {
        declared: islands.declared,
        booted: islands.booted,
        mounted: islands.mounted,
        failed: islands.failed,
        byStrategy: islands.byStrategy,
        failures: islands.failures.map((failure) => ({
          island: failure.island,
          message: failure.message,
        })),
      };

/** The artifact, and the same object `--json` carries under `data.verdict`. One shape, two files. */
export function verdictJson(verdict: ShotVerdict): JsonValue {
  return {
    ok: verdict.ok,
    route: verdict.route,
    requestedUrl: verdict.requestedUrl,
    finalUrl: verdict.finalUrl,
    redirected: verdict.redirected,
    server: verdict.server,
    capturedAt: verdict.capturedAt,
    screenshot: verdict.screenshot,
    bytes: verdict.bytes.byteLength,
    canvas:
      verdict.canvas === null
        ? null
        : {
            width: verdict.canvas.width,
            height: verdict.canvas.height,
            format: verdict.canvas.format,
          },
    console: {
      total: verdict.console.length,
      errors: verdict.errors,
      warnings: verdict.warnings,
      lines: consoleJson(verdict.console),
    },
    // Its own object, never merged into `console`: an uncaught exception calls no console method,
    // and a reader who finds throws under `console` will look for them in the wrong stream.
    pageErrors: {
      total: verdict.pageErrors.length,
      dropped: verdict.pageErrorsDropped,
      thrown: verdict.pageErrors.map((error) => ({
        message: error.message,
        stack: error.stack ?? null,
        at: error.at,
      })),
    },
    islands: islandJson(verdict.islands),
    network: {
      requests: verdict.network.length,
      refused: verdict.refused,
      dropped: verdict.networkDropped,
    },
    blind: [...verdict.blind],
  };
}

export interface ShotArtifacts {
  readonly verdict: ShotVerdict;
  /** Absolute path of the picture. */
  readonly image: string;
  /** Absolute path of this verdict on disk. */
  readonly verdictFile: string;
}

const consoleLines = (verdict: ShotVerdict): readonly string[] =>
  verdict.console
    .filter((line) => line.level === 'error' || line.level === 'warn')
    .map((line) => msg('cli.shot.console', { level: line.level, text: line.text.slice(0, 200) }));

/** Human lines. Every fact here is a fact `--json` carries under `data.verdict`. */
export function shotLines(artifacts: ShotArtifacts): readonly string[] {
  const verdict = artifacts.verdict;
  const islands = verdict.islands;
  const canvas = verdict.canvas;
  return [
    msg(`cli.shot.server.${verdict.server}`, { url: verdict.finalUrl }),
    canvas === null
      ? msg('cli.shot.canvasUnreadable', { bytes: verdict.bytes.byteLength })
      : msg('cli.shot.canvas', { width: canvas.width, height: canvas.height }),
    islands === null
      ? msg('cli.shot.islandsUnknown')
      : msg('cli.shot.islands', {
          booted: islands.mounted,
          declared: islands.declared,
          strategies: Object.entries(islands.byStrategy)
            .map(([name, count]) => `${name}=${count}`)
            .join(' '),
        }),
    msg('cli.shot.network', {
      requests: verdict.network.length,
      refused: verdict.refused,
      dropped: verdict.networkDropped,
    }),
    ...verdict.pageErrors.map((error) =>
      msg('cli.shot.pageError', {
        message: error.message,
        // The frame that names the island module and line. `message` alone says what went wrong
        // and never where, which is the difference between a report and a lead.
        at: error.stack?.split('\n')[1]?.trim() ?? '',
      }),
    ),
    ...consoleLines(verdict),
    msg('cli.shot.picture', { path: artifacts.image }),
    msg('cli.shot.verdict', { path: artifacts.verdictFile }),
  ];
}

/** The one line a reader sees first, and it names the gating fact rather than the file count. */
export const shotSummary = (verdict: ShotVerdict): string => {
  if (verdict.redirected) {
    return msg('cli.shot.redirected', { route: verdict.route, url: verdict.finalUrl });
  }
  // Ahead of the console count, because a throw is the more severe fact AND the quieter one: an
  // island that died can log nothing at all, so `errors` would report a clean page.
  if (verdict.pageErrors.length > 0) {
    return msg('cli.shot.threw', {
      route: verdict.route,
      thrown: verdict.pageErrors.length,
      first: verdict.pageErrors[0]?.message ?? '',
    });
  }
  // Ahead of the console count for the same reason, and it is the same silence: a rejected mount
  // promise calls no console method either, so a page whose every island died can read `errors: 0`.
  // The first failure is NAMED — "1 island failed" sends a reader back to the artifact for the one
  // fact they need to start.
  const failure = verdict.islands?.failures[0];
  if (failure !== undefined) {
    return msg('cli.shot.islandFailed', {
      route: verdict.route,
      failed: verdict.islands?.failed ?? 0,
      island: failure.island,
      message: failure.message,
    });
  }
  if (verdict.errors > 0) {
    return msg('cli.shot.errors', { route: verdict.route, errors: verdict.errors });
  }
  // `mounted`, not `booted`: "the runtime asked for the chunk" is not the claim worth making when
  // the DOM can now say the mount RESOLVED.
  return msg('cli.shot.ok', { route: verdict.route, islands: verdict.islands?.mounted ?? 0 });
};
