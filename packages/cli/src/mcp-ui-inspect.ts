// `ui.inspect` — the dev MCP server's third eye, and the one that reads instead of looking. A
// browser is the cost of every `ui.*` call, so this one reads MANY facts per navigation: for each
// selector the tag, text, box, visibility, attributes, named computed styles and (on request) the
// browser-computed role and name; for the document its title, `data-theme`, the focused element,
// the island count and both error streams. It is `runShot` with an `act` hook — the same boot,
// the same driver, the same verdict, the same PNG under an `inspect/` subdirectory — so `ok` here
// means exactly what `ui.shot`'s `ok` means, and a page that threw while an agent was reading
// its styles is a finding beside the styles.

// why: Bun exposes no path-join primitive, and the directory is a path an agent opens.
import { join } from 'node:path';
import type { UiInspectInput, UiInspectResult, UiInspectSelector } from '@ultimat3/mcp';
import { UI_INSPECT_LIMITS } from '@ultimat3/mcp';
import type { AxNode, ScrapeDriver } from '@ultimat3/scraping';
import { DEFAULT_PAGE_TIMEOUT_MS } from '@ultimat3/scraping';
import { DEFAULT_SETTLE_MS, runShot, SHOT_DIR, shotSlug } from './cmd-shot';
import type { ShotServer } from './shot-server';
import type { ShotVerdict } from './shot-verdict';
import type { InspectProbe } from './ui-inspect-probe';
import { inspectExpression, parseInspectProbe } from './ui-inspect-probe';

export interface InspectDeps {
  readonly root: string;
  /** The memoised scratch server (or the running `x dev`), as `uiCapabilities` hands it out. */
  readonly boot: () => Promise<ShotServer>;
  readonly driver: (viewport: UiInspectInput['viewport']) => Promise<ScrapeDriver>;
}

/** What the page answered before the parser had a say — `null` selectors when it answered nothing. */
interface Seen {
  probe: InspectProbe | null;
  /** Per selector, in the input's order: the a11y nodes, or `null` when not asked. */
  a11y: readonly (readonly AxNode[] | null)[];
}

/**
 * The empty answer for a selector the page never described: the probe refused to run, or answered
 * a shape the parser did not accept. `valid: false` is the honest reading — nothing about this
 * selector was established — and the verdict beside it says whether the page was broken.
 */
const unanswered = (selector: string): UiInspectSelector => ({
  selector,
  valid: false,
  count: 0,
  truncated: false,
  matches: [],
});

function selectorsOf(input: UiInspectInput, seen: Seen): readonly UiInspectSelector[] {
  return input.selectors.map((selector, index): UiInspectSelector => {
    const found = seen.probe?.selectors[index];
    if (found === undefined) return unanswered(selector);
    const nodes = seen.a11y[index] ?? null;
    return {
      selector,
      valid: found.valid,
      count: found.count,
      truncated: found.truncated,
      // Merged BY INDEX: both reads walk `querySelectorAll` in document order over the same DOM,
      // one navigation apart from nothing. A node the a11y read did not cover keeps no `a11y` key.
      matches: found.matches.map((match, at) => {
        const node = nodes?.[at];
        return node === undefined
          ? match
          : { ...match, a11y: { role: node.role, name: node.name } };
      }),
    };
  });
}

const encoded = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The wire cap. Matches are dropped from the LAST selectors first — an agent lists what it cares
 * about most first, and a cap that emptied the first selector would take the fact the call was
 * for. The selector keeps its `count` and gains `truncated: true`, so the drop is visible.
 */
export function capInspect(result: UiInspectResult): UiInspectResult {
  if (encoded(result) <= UI_INSPECT_LIMITS.bytes) return result;
  const selectors = [...result.selectors];
  let truncated = result.truncated;
  for (let index = selectors.length - 1; index >= 0; index -= 1) {
    const entry = selectors[index];
    if (entry === undefined || entry.matches.length === 0) continue;
    selectors[index] = { ...entry, truncated: true, matches: [] };
    truncated = true;
    if (encoded({ ...result, selectors, truncated }) <= UI_INSPECT_LIMITS.bytes) break;
  }
  return { ...result, selectors, truncated };
}

const errorsOf = (verdict: ShotVerdict): readonly string[] =>
  verdict.console.filter((line) => line.level === 'error').map((line) => line.text);

export async function inspectRoute(
  deps: InspectDeps,
  input: UiInspectInput,
): Promise<UiInspectResult> {
  const expression = inspectExpression({
    selectors: input.selectors,
    styles: input.styles,
    activeElement: input.activeElement,
  });
  // A holder rather than two `let`s: an assignment inside the `act` closure does not reach the
  // narrowing below, and a `let` typed `null` after the await is what the compiler would see.
  const seen: Seen = { probe: null, a11y: [] };
  const driver = await deps.driver(input.viewport);
  // Its own subdirectory under the (route, viewport, scheme) one, so an inspect and a shot of the
  // same route at the same size never overwrite each other's verdict.
  const outDir = join(
    deps.root,
    SHOT_DIR,
    shotSlug(input.route),
    `${input.viewport.width}x${input.viewport.height}-${input.colorScheme}`,
    'inspect',
  );
  const artifacts = await runShot({
    route: input.route,
    outDir,
    driver,
    boot: deps.boot,
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    fullPage: true,
    colorScheme: input.colorScheme,
    act: async (page) => {
      // `.catch(() => null)` for the island probe's reason: a page that refuses evaluation is a
      // page with no facts, and the verdict — not a throw here — is what says why.
      seen.probe = await page
        .evaluate(expression)
        .then(parseInspectProbe)
        .catch(() => null);
      if (!input.a11y) return;
      const nodes: (readonly AxNode[] | null)[] = [];
      for (const selector of input.selectors) {
        nodes.push(await page.accessibility(selector, { max: UI_INSPECT_LIMITS.matches }));
      }
      seen.a11y = nodes;
    },
  });
  const verdict = artifacts.verdict;
  return capInspect({
    ok: verdict.ok,
    route: input.route,
    finalUrl: verdict.finalUrl,
    title: seen.probe?.title ?? '',
    theme: seen.probe?.theme ?? null,
    activeElement: seen.probe?.activeElement ?? null,
    islands:
      verdict.islands === null
        ? null
        : {
            declared: verdict.islands.declared,
            booted: verdict.islands.booted,
            mounted: verdict.islands.mounted,
            failed: verdict.islands.failed,
          },
    consoleErrors: errorsOf(verdict),
    pageErrors: verdict.pageErrors.map((error) => error.message),
    refused: verdict.refused,
    selectors: selectorsOf(input, seen),
    image: artifacts.image,
    verdictFile: artifacts.verdictFile,
    truncated: false,
    droppedStyles: [],
  });
}
