import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { UiInteractInput, UiInteractResult } from './dev-ui-interact';
import { UI_INTERACT_STEP_SCHEMA, uiInteractTools } from './dev-ui-interact';
import type { McpCaller, McpToolResult } from './registry';
import { validateArgs } from './validate-args';

const caller: McpCaller = {
  actor: { kind: 'agent', id: 'a1' } as unknown as Actor,
  scopes: new Set(['dev:test']),
} as unknown as McpCaller;

const textOf = (result: McpToolResult | undefined): string | undefined => {
  const first = result?.content[0];
  return first?.type === 'text' ? first.text : undefined;
};

const RESULT: UiInteractResult = {
  ok: true,
  route: '/dash',
  finalUrl: 'http://localhost:3000/dash',
  image: '/x/interact-abc/shot.png',
  verdictFile: '/x/interact-abc/verdict.json',
  verdict: {},
  steps: [],
};

function recording(): {
  tool: ReturnType<typeof uiInteractTools>[number];
  asked: UiInteractInput[];
} {
  const asked: UiInteractInput[] = [];
  const [tool] = uiInteractTools(
    {
      async interactRoute(input) {
        asked.push(input);
        return {
          ...RESULT,
          ...(input.inspect === undefined
            ? {}
            : {
                inspect: {
                  title: 'Dash',
                  theme: null,
                  activeElement: null,
                  selectors: input.inspect.selectors.map((selector) => ({
                    selector,
                    valid: true,
                    count: 0,
                    truncated: false,
                    matches: [],
                  })),
                  truncated: false,
                  droppedStyles: [],
                },
              }),
        };
      },
    },
    'dev:test',
  );
  if (tool === undefined) throw new TypeError('no ui.interact tool');
  return { tool, asked };
}

const valid = (steps: unknown): boolean =>
  validateArgs(recording().tool.inputSchema, { route: '/dash', steps }).ok;

describe('unit · the ui.interact step schema is anyOf over five one-key shapes', () => {
  test('each verb validates alone', () => {
    expect(valid([{ click: '#a' }])).toBe(true);
    expect(valid([{ type: { selector: '#q', text: 'hi' } }])).toBe(true);
    expect(valid([{ press: 'Meta+K' }])).toBe(true);
    expect(valid([{ focus: '#q' }])).toBe(true);
    expect(valid([{ wait: 250 }])).toBe(true);
    expect(valid([{ wait: '[role=dialog]' }])).toBe(true);
    expect(UI_INTERACT_STEP_SCHEMA.anyOf).toHaveLength(5);
  });

  test('two verbs, no verb, an unknown verb, an empty selector or a half type are refused', () => {
    expect(valid([{ click: '#a', press: 'Enter' }])).toBe(false);
    expect(valid([{}])).toBe(false);
    expect(valid([{ hover: '#a' }])).toBe(false);
    expect(valid([{ click: '' }])).toBe(false);
    expect(valid([{ type: { selector: '#q' } }])).toBe(false);
    expect(valid([{ wait: -1 }])).toBe(false);
    expect(valid([{ wait: true }])).toBe(false);
    expect(valid('click')).toBe(false);
  });

  test('the schema states no maxItems — the count is the handler contract, refused by the CLI', () => {
    expect(JSON.stringify(recording().tool.inputSchema)).not.toContain('maxItems');
    expect(valid(Array.from({ length: 13 }, () => ({ wait: 1 })))).toBe(true);
  });
});

describe('unit · the ui.interact handler', () => {
  test('fullPage defaults to FALSE, viewport to desktop, theme to dark; steps pass through in order', async () => {
    const { tool, asked } = recording();
    expect(tool.destructive).toBe(true);
    expect(tool.scope).toBe('dev:test');
    const steps = [{ click: '#open' }, { wait: '[role=dialog]' }];
    const result = await tool.handle({ route: '/dash', steps }, caller);
    expect(asked[0]).toEqual({
      route: '/dash',
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
      fullPage: false,
      steps,
    });
    expect(result.isError).toBeUndefined();
    await tool.handle(
      { route: '/dash', steps, fullPage: true, viewport: 'phone', theme: 'light' },
      caller,
    );
    expect(asked[1]).toMatchObject({
      fullPage: true,
      viewport: { width: 390 },
      colorScheme: 'light',
    });
  });

  test('the inspect block is bounded like ui.inspect’s and the trims are confessed', async () => {
    const { tool, asked } = recording();
    const selectors = Array.from({ length: 21 }, (_, i) => `#s${i}`);
    const result = await tool.handle(
      { route: '/dash', steps: [], inspect: { selectors, styles: ['color', 'fontSize'] } },
      caller,
    );
    expect(asked[0]?.inspect?.selectors).toHaveLength(20);
    expect(asked[0]?.inspect?.styles).toEqual(['color']);
    expect(asked[0]?.inspect?.a11y).toBe(false);
    expect(asked[0]?.inspect?.activeElement).toBe(true);
    const answer = JSON.parse(textOf(result) ?? '{}') as UiInteractResult;
    expect(answer.inspect?.truncated).toBe(true);
    expect(answer.inspect?.droppedStyles).toEqual(['fontSize']);
    // No block asked, none answered.
    await tool.handle({ route: '/dash', steps: [] }, caller);
    expect(asked[1]?.inspect).toBeUndefined();
  });

  test('a verdict that is not ok is an isError result', async () => {
    const [tool] = uiInteractTools(
      {
        async interactRoute() {
          return { ...RESULT, ok: false };
        },
      },
      'dev:test',
    );
    expect((await tool?.handle({ route: '/dash', steps: [] }, caller))?.isError).toBe(true);
  });
});
