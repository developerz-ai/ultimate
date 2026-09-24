// `ui.interact` — the dev MCP server's hand. The three `ui.*` eyes photograph a route as it loads;
// this one drives it first — opens the ⌘K palette, raises a dialog, types into a field — and
// then takes the same picture, the same verdict and (on request) `ui.inspect`'s facts, in ONE
// navigation. It is `runShot` with an `act` hook whose body is the step list: after EVERY step the
// island poll re-runs (a click that mounts something changes the count the verdict reports) and
// one poll interval passes for the CSS transition the click started.
//
// Four refusals, and every one refuses WHOLE rather than trims, skips or follows: a dropped step,
// a swallowed keystroke or a navigation quietly followed changes what the picture is of, and an
// agent judging that picture would judge the wrong thing.

// why: Bun exposes no path-join primitive, and the directory is a path an agent opens.
import { join } from 'node:path';
import { isUltimateError, toUltimateError, UltimateError } from '@ultimat3/core';
import type { UiInteractInput, UiInteractResult, UiInteractStepResult } from '@ultimat3/mcp';
import { UI_INTERACT_LIMITS } from '@ultimat3/mcp';
import type { ShotPage } from './browser-launcher-port';
import { DEFAULT_PAGE_TIMEOUT_MS } from './cdp-shot-clock';
import { DEFAULT_SETTLE_MS, runShot, SHOT_DIR, shotSlug } from './cmd-shot';
import type { InspectDeps, Seen } from './mcp-ui-inspect';
import { readInspect, selectorsOf } from './mcp-ui-inspect';
import { SETTLE_POLL_MS } from './shot-settle';
import type { IslandCount } from './shot-verdict';
import { verdictJson } from './shot-verdict';

export interface InteractDeps extends InspectDeps {
  /** Injected by the test, so the per-step transition frame is proved without spending it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** A step after parsing: one verb, its argument, and the bounds already held. */
export type InteractStep =
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'type'; readonly selector: string; readonly text: string }
  | { readonly kind: 'press'; readonly chord: string }
  | { readonly kind: 'focus'; readonly selector: string }
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'wait'; readonly selector: string };

/**
 * The four fix lines, verbatim from `mcp-errors.ts`'s `CLI_FIXES` — an error's fix travels IN the
 * error, and `errors.explain` answers the same text.
 */
const FIX = {
  invalid:
    'x help shot --json   # then resend ui.interact with at most 12 one-key steps, type.text under 500 chars and wait under 5000 ms',
  secret:
    'x shot --all-islands --json   # or --island <name>: a declared state renders the filled form without the secret ever being typed',
  left: 'x routes --json   # then resend ui.interact with steps that stay on one of its paths',
  failed:
    'x routes --json   # then run ui.inspect on the route first and copy a selector it reports with count >= 1',
} as const;

const invalid = (cause: string): UltimateError =>
  new UltimateError({ code: 'X_UI_INTERACT_STEPS_INVALID', cause, fix: FIX.invalid });

const nonEmpty = (value: unknown, at: string): string => {
  if (typeof value !== 'string' || value === '') throw invalid(`${at} must be a non-empty string`);
  return value;
};

function parseStep(raw: Readonly<Record<string, unknown>>, index: number): InteractStep {
  const keys = Object.keys(raw);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) {
    throw invalid(
      `step ${index} names ${keys.length} verbs (${keys.join(', ')}); a step is ONE of click, type, press, focus, wait`,
    );
  }
  const at = `step ${index} (${key})`;
  // `Object.hasOwn` narrowed the key set above; the read below is on a literal the parser owns.
  const value: unknown = Object.hasOwn(raw, key) ? raw[key] : undefined;
  switch (key) {
    case 'click':
      return { kind: 'click', selector: nonEmpty(value, at) };
    case 'focus':
      return { kind: 'focus', selector: nonEmpty(value, at) };
    case 'press':
      return { kind: 'press', chord: nonEmpty(value, at) };
    case 'type': {
      if (typeof value !== 'object' || value === null)
        throw invalid(`${at} needs { selector, text }`);
      const field = value as { readonly selector?: unknown; readonly text?: unknown };
      const text = nonEmpty(field.text, `${at}.text`);
      if (text.length > UI_INTERACT_LIMITS.textChars) {
        throw invalid(
          `${at}.text is ${text.length} chars; the cap is ${UI_INTERACT_LIMITS.textChars}`,
        );
      }
      return { kind: 'type', selector: nonEmpty(field.selector, `${at}.selector`), text };
    }
    case 'wait': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0 || value > UI_INTERACT_LIMITS.waitMs) {
          throw invalid(`${at} is ${value} ms; the cap is ${UI_INTERACT_LIMITS.waitMs}`);
        }
        return { kind: 'wait', ms: value };
      }
      return { kind: 'wait', selector: nonEmpty(value, at) };
    }
    default:
      throw invalid(`${at} is not a verb; a step is ONE of click, type, press, focus, wait`);
  }
}

/** The whole list or nothing: a trimmed list photographs a different scene than the one asked for. */
export function parseSteps(raw: UiInteractInput['steps']): readonly InteractStep[] {
  if (raw.length > UI_INTERACT_LIMITS.steps) {
    throw invalid(`${raw.length} steps; the cap is ${UI_INTERACT_LIMITS.steps}`);
  }
  return raw.map(parseStep);
}

/** Eight hex chars of `Bun.hash` over the raw list — deterministic per step list, never per run. */
export const stepsHash = (raw: UiInteractInput['steps']): string =>
  Bun.hash(JSON.stringify(raw)).toString(16).padStart(16, '0').slice(0, 8);

const describe = (step: InteractStep): string => {
  switch (step.kind) {
    case 'click':
    case 'focus':
      return `${step.kind} ${JSON.stringify(step.selector)}`;
    case 'press':
      return `press ${JSON.stringify(step.chord)}`;
    case 'type':
      return `type into ${JSON.stringify(step.selector)}`;
    case 'wait':
      return 'ms' in step ? `wait ${step.ms}ms` : `wait for ${JSON.stringify(step.selector)}`;
  }
};

async function perform(
  page: ShotPage,
  step: InteractStep,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  switch (step.kind) {
    case 'click':
      return page.click(step.selector);
    case 'focus':
      return page.focus(step.selector);
    case 'press':
      return page.press(step.chord);
    case 'type':
      return page.type(step.selector, step.text);
    case 'wait':
      if ('ms' in step) return sleep(step.ms);
      await page.waitFor(step.selector, { state: 'visible', timeout: DEFAULT_PAGE_TIMEOUT_MS });
  }
}

/**
 * Before any keystroke: a password field's value would land in the PNG, the verdict's console and
 * an agent's transcript. The read is the driver's own `query`, so the fake answers it offline.
 */
/** The `type` of the focused element — what a `press` step's key lands in. */
export const ACTIVE_FIELD_TYPE =
  '(function(){var a=document.activeElement;return a&&a.getAttribute?a.getAttribute("type"):null})()';

async function refuseSecretField(page: ShotPage, step: InteractStep, index: number): Promise<void> {
  if (step.kind !== 'type' && step.kind !== 'press') return;
  // A `press` goes to whatever has focus: `focus` a password field, then eleven presses, typed
  // the password the `type` guard refused — so the focused element is asked before each key.
  const secret =
    step.kind === 'type'
      ? (await page.query(step.selector))[0]?.attrs['type'] === 'password'
      : (await page.evaluate(ACTIVE_FIELD_TYPE)) === 'password';
  if (!secret) return;
  const target = step.kind === 'type' ? JSON.stringify(step.selector) : 'the focused element';
  throw new UltimateError({
    code: 'X_UI_INTERACT_SECRET_FIELD',
    cause: `step ${index} would type into ${target}, an <input type="password">`,
    fix: FIX.secret,
    meta: { step: index, ...(step.kind === 'type' ? { selector: step.selector } : {}) },
  });
}

export interface StepsRun {
  readonly steps: readonly UiInteractStepResult[];
  /** Some step changed the page's URL — the navigation `ok` must not read as a redirect. */
  readonly navigated: boolean;
}

/**
 * The steps in order, each followed by a settle and one poll interval, each checked against the
 * origin. A driver error is wrapped, never passed through: the agent needs to know WHICH step,
 * and the fix is a selector `ui.inspect` reports rather than whatever the driver's fix names.
 */
export async function runSteps(
  page: ShotPage,
  steps: readonly InteractStep[],
  settle: () => Promise<IslandCount | null>,
  origin: string,
  sleep: (ms: number) => Promise<void>,
): Promise<StepsRun> {
  const results: UiInteractStepResult[] = [];
  let navigated = false;
  for (const [index, step] of steps.entries()) {
    const before = page.url();
    const started = performance.now();
    await refuseSecretField(page, step, index);
    try {
      await perform(page, step, sleep);
    } catch (error) {
      const inner = isUltimateError(error) ? error : toUltimateError(error);
      throw new UltimateError({
        code: 'X_UI_INTERACT_STEP_FAILED',
        cause: `step ${index} (${describe(step)}): ${inner.code} — ${inner.cause}`,
        fix: FIX.failed,
        meta: { step: index, code: inner.code },
        sourceError: error,
      });
    }
    const url = page.url();
    if (new URL(url).origin !== origin) {
      throw new UltimateError({
        code: 'X_UI_INTERACT_LEFT_APP',
        cause: `step ${index} (${describe(step)}) navigated to ${url}, off ${origin}`,
        fix: FIX.left,
        meta: { step: index, url },
      });
    }
    await settle();
    await sleep(SETTLE_POLL_MS);
    const moved = url !== before;
    navigated = navigated || moved;
    results.push({
      index,
      kind: step.kind,
      ms: Math.round(performance.now() - started),
      navigated: moved,
      url,
    });
  }
  return { steps: results, navigated };
}

export async function interactRoute(
  deps: InteractDeps,
  input: UiInteractInput,
): Promise<UiInteractResult> {
  // Parsed BEFORE a browser exists: a refused list costs no navigation.
  const steps = parseSteps(input.steps);
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  const server = await deps.boot();
  const origin = new URL(server.url).origin;
  const requestedUrl = new URL(input.route, server.url).toString();
  const driver = await deps.driver(input.viewport);
  const outDir = join(
    deps.root,
    SHOT_DIR,
    shotSlug(input.route),
    `${input.viewport.width}x${input.viewport.height}-${input.colorScheme}`,
    `interact-${stepsHash(input.steps)}`,
  );
  // Holders rather than `let`s, for `ui.inspect`'s reason: an assignment inside `act` does not
  // reach the narrowing below.
  const ran: { run: StepsRun | null; seen: Seen | null; landedOn: string } = {
    run: null,
    seen: null,
    landedOn: '',
  };
  const artifacts = await runShot({
    route: input.route,
    outDir,
    driver,
    boot: deps.boot,
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    fullPage: input.fullPage,
    colorScheme: input.colorScheme,
    act: async (page, settle) => {
      ran.landedOn = page.url();
      ran.run = await runSteps(page, steps, settle, origin, sleep);
      if (input.inspect !== undefined) ran.seen = await readInspect(page, input.inspect);
    },
  });
  const verdict = artifacts.verdict;
  const run = ran.run ?? { steps: [], navigated: false };
  // The verdict fails a capture whose final URL is not the one requested — the sign-in redirect
  // rule. A step that navigated is the agent's doing, not the server's, so it is excused ONLY
  // when the page landed where it was asked and the verdict's other three rules hold.
  const excused =
    run.navigated &&
    ran.landedOn === requestedUrl &&
    verdict.errors === 0 &&
    verdict.pageErrors.length === 0 &&
    (verdict.islands?.failed ?? 0) === 0;
  const inspect =
    input.inspect === undefined || ran.seen === null
      ? undefined
      : {
          title: ran.seen.probe?.title ?? '',
          theme: ran.seen.probe?.theme ?? null,
          activeElement: ran.seen.probe?.activeElement ?? null,
          selectors: selectorsOf(input.inspect, ran.seen),
          truncated: false,
          droppedStyles: [],
        };
  return {
    ok: verdict.ok || excused,
    route: input.route,
    finalUrl: verdict.finalUrl,
    image: artifacts.image,
    verdictFile: artifacts.verdictFile,
    verdict: verdictJson(verdict),
    steps: run.steps,
    ...(inspect === undefined ? {} : { inspect }),
  };
}
