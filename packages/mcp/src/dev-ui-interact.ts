// `ui.interact` — the dev server's hand. An agent that needs the ⌘K palette open, a dialog up or a
// field filled before the picture is worth taking drives the route through a BOUNDED list of
// steps, and gets the picture, the verdict and (on request) `ui.inspect`'s facts in ONE
// navigation. Its own file for the reason `dev-ui-tools.ts` has one: that file stands near the
// 500-line ceiling, and this tool's step schema alone is a screen. `dev-server.ts` spreads both.
//
// Every bound lives in the HANDLER's contract, not the schema: `validate-args.ts` enforces no
// `maxItems`, and a step list the schema cannot bound is one the CLI refuses whole — never trims,
// because dropping a step changes what the picture is of. The schema's job is the SHAPE of a step
// (`anyOf` over five one-key objects); the CLI's is the count, the lengths and the policies.

import type {
  UiColorScheme,
  UiInspectActive,
  UiInspectInput,
  UiInspectSelector,
} from './dev-ui-tools';
import { inspectSpecOf, VIEWPORT_ARGS, viewportOf } from './dev-ui-tools';
import type { AnyMcpTool, ToolArgs } from './registry';
import { jsonResult } from './registry';
import type { JsonSchema } from './wire';

/**
 * Bounds the CLI holds a step list to. `steps` is a scene, not a script: twelve is enough to open
 * a palette, type a query and pick a row, and a longer list is a test that belongs in `x test`.
 * `waitMs` is a CSS transition's worth, not a network's — a `wait` on a selector waits within the
 * shot timeout instead. `textChars` bounds what one `type` step may put into a field.
 */
export const UI_INTERACT_LIMITS = { steps: 12, textChars: 500, waitMs: 5000 } as const;

/** One step, as the wire carries it: exactly ONE key, naming the verb. */
export type UiInteractStep =
  | { readonly click: string }
  | { readonly type: { readonly selector: string; readonly text: string } }
  | { readonly press: string }
  | { readonly focus: string }
  | { readonly wait: number | string };

export type UiInteractStepKind = 'click' | 'type' | 'press' | 'focus' | 'wait';

/** The `ui.inspect` block `ui.interact` runs AFTER its steps — the same four fields, same bounds. */
export type UiInspectSpec = Pick<UiInspectInput, 'selectors' | 'styles' | 'a11y' | 'activeElement'>;

export interface UiInteractInput {
  readonly route: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly colorScheme: UiColorScheme;
  /** Default FALSE, unlike `ui.shot`: a dialog or a palette is judged on the fold it opened in. */
  readonly fullPage: boolean;
  /**
   * What the wire carried, one record per step, already shaped by the schema's `anyOf`. Records
   * and not `UiInteractStep`: the CLI parses them — count, lengths, the one-key rule — and refuses
   * the whole list with `X_UI_INTERACT_STEPS_INVALID`, so a host reached without the schema (a
   * test, a script) is held to the same rule.
   */
  readonly steps: readonly Readonly<Record<string, unknown>>[];
  readonly inspect?: UiInspectSpec | undefined;
}

export interface UiInteractStepResult {
  readonly index: number;
  readonly kind: UiInteractStepKind;
  /** Wall time the step took, settle included. */
  readonly ms: number;
  /** The page's URL changed during this step — a same-origin navigation the step caused. */
  readonly navigated: boolean;
  readonly url: string;
}

/** `ui.inspect`'s document-and-selectors block, read after the last step settled. */
export interface UiInteractInspect {
  readonly title: string;
  readonly theme: string | null;
  readonly activeElement: UiInspectActive | null;
  readonly selectors: readonly UiInspectSelector[];
  readonly truncated: boolean;
  readonly droppedStyles: readonly string[];
}

export interface UiInteractResult {
  /**
   * The verdict's `ok` — with one reading of its own: a same-origin navigation a STEP caused is
   * not the redirect `ui.shot` fails a capture for. The verdict still reports `redirected`.
   */
  readonly ok: boolean;
  readonly route: string;
  readonly finalUrl: string;
  readonly image: string;
  readonly verdictFile: string;
  readonly verdict: unknown;
  readonly steps: readonly UiInteractStepResult[];
  readonly inspect?: UiInteractInspect | undefined;
}

export interface UiInteractHost {
  interactRoute(input: UiInteractInput): Promise<UiInteractResult>;
}

const selector = (what: string): JsonSchema => ({
  type: 'string',
  minLength: 1,
  description: what,
});

const oneKey = (key: string, value: JsonSchema): JsonSchema => ({
  type: 'object',
  properties: { [key]: value },
  required: [key],
  additionalProperties: false,
});

/** Five shapes, one key each. A step with two verbs has no order, so it has no shape here. */
export const UI_INTERACT_STEP_SCHEMA: JsonSchema = {
  anyOf: [
    oneKey('click', selector('CSS selector of the element to click (first match).')),
    oneKey('type', {
      type: 'object',
      properties: {
        selector: selector('CSS selector of the field; a password field is refused.'),
        text: {
          type: 'string',
          minLength: 1,
          description: `Keystrokes to send, at most ${UI_INTERACT_LIMITS.textChars} characters.`,
        },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    }),
    oneKey('press', selector("A key chord on whatever holds focus: 'Meta+K', 'Escape', 'Enter'.")),
    oneKey('focus', selector('CSS selector of the element to move focus to.')),
    oneKey('wait', {
      anyOf: [
        {
          type: 'integer',
          minimum: 0,
          description: `Milliseconds to pause, at most ${UI_INTERACT_LIMITS.waitMs}.`,
        },
        selector('CSS selector to wait VISIBLE, within the shot timeout.'),
      ],
    }),
  ],
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Everything array-shaped goes through; the CLI is the parser, and it refuses whole. */
const stepsOf = (value: unknown): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(value)
    ? value.map((item): Readonly<Record<string, unknown>> => (isRecord(item) ? item : {}))
    : [];

/** The one `ui.interact` tool, spread into the dev catalog beside the three `ui.*` eyes. */
export function uiInteractTools(host: UiInteractHost, scope: string): readonly AnyMcpTool[] {
  return [
    {
      name: 'ui.interact',
      description:
        `Drive one route through at most ${UI_INTERACT_LIMITS.steps} steps — click, type, press a ` +
        'key chord, focus, wait — then photograph it and (optionally) read the same DOM, style and ' +
        'a11y facts ui.inspect reads, all in ONE navigation. Each step waits for the islands to ' +
        'settle; per step you get whether it navigated and where. Refuses a step list over the ' +
        "bounds (never trims), typing into a password field, and any step that leaves the app's " +
        'origin. Same PNG and verdict as ui.shot, under interact-<hash>/; `ok` is the verdict. ' +
        'Launches a browser.',
      scope,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route path, e.g. /dashboard.' },
          ...VIEWPORT_ARGS,
          fullPage: { type: 'boolean', default: false },
          steps: {
            type: 'array',
            items: UI_INTERACT_STEP_SCHEMA,
            description:
              `In order, at most ${UI_INTERACT_LIMITS.steps}. Each is ONE of {click}, {type: {selector, text}}, ` +
              '{press}, {focus}, {wait: ms | selector}.',
          },
          inspect: {
            type: 'object',
            description:
              'ui.inspect’s block, run after the last step: selectors, styles, a11y, activeElement.',
            properties: {
              selectors: { type: 'array', items: { type: 'string', minLength: 1 } },
              styles: { type: 'array', items: { type: 'string' } },
              a11y: { type: 'boolean', default: false },
              activeElement: { type: 'boolean', default: true },
            },
            required: ['selectors'],
            additionalProperties: false,
          },
        },
        required: ['route', 'steps'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const route = typeof args['route'] === 'string' ? args['route'] : '';
        const asked = isRecord(args['inspect']) ? inspectSpecOf(args['inspect']) : undefined;
        const result = await host.interactRoute({
          route,
          viewport: viewportOf(args),
          colorScheme: args['theme'] === 'light' ? 'light' : 'dark',
          fullPage: args['fullPage'] === true,
          steps: stepsOf(args['steps']),
          ...(asked === undefined ? {} : { inspect: asked.spec }),
        });
        // The same confession `ui.inspect` makes: what the handler trimmed, named in the answer.
        const inspect =
          result.inspect === undefined || asked === undefined
            ? result.inspect
            : {
                ...result.inspect,
                truncated: result.inspect.truncated || asked.trimmed,
                droppedStyles: asked.droppedStyles,
              };
        const answer: UiInteractResult = {
          ...result,
          ...(inspect === undefined ? {} : { inspect }),
        };
        return { ...jsonResult(answer), ...(answer.ok ? {} : { isError: true }) };
      },
    },
  ];
}
