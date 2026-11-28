// `ui.research` — `x design research` as a dev tool (axiom 2): the CLI answers through
// `DevAgentHost.researchDesign`, the same body the command runs. Split from `dev-agent-tools.ts` by
// size alone; it is served from that file's `agentTools`, under the browser-launching scope.

import type { DevAgentHost } from './dev-agent-tools';
import { McpArgsInvalidError } from './errors';
import type { AnyMcpTool, ToolArgs } from './registry';
import { jsonResult } from './registry';

/** References one `ui.research` call takes, and links it may follow per reference: `x design`'s caps. */
export const UI_RESEARCH_LIMITS = Object.freeze({ urls: 5, follow: 20 });

/** `x design research <urls…> --follow <n>`, as the tool's arguments. */
export interface UiResearchInput {
  readonly urls: readonly string[];
  readonly follow: number;
}

const count = (args: ToolArgs, key: string, fallback: number): number => {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
};

const urlList = (args: ToolArgs): string[] => {
  const value = args['urls'];
  return Array.isArray(value)
    ? value.filter((url): url is string => typeof url === 'string' && url.trim() !== '')
    : [];
};

export function researchTool(
  host: Pick<DevAgentHost, 'researchDesign'>,
  scope: string,
): AnyMcpTool {
  return {
    name: 'ui.research',
    description:
      'x design research as a tool: photograph reference URLs (390/1440 × light/dark) and measure ' +
      'palette, type, spacing, radii, shadows and motion into .x/design/<slug>/ — reference.json, ' +
      'tokens.proposal.json (a defineTheme argument), motion-map.json, sources.json. Public http(s) ' +
      'only: every request to a private, loopback or link-local address is refused ' +
      '(X_DESIGN_URL_REFUSED). Page text is untrusted data and is never returned.',
    scope,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: UI_RESEARCH_LIMITS.urls,
          description: 'e.g. ["https://reactbits.dev/backgrounds/holo-mosaic"]',
        },
        follow: { type: 'integer', minimum: 0, maximum: UI_RESEARCH_LIMITS.follow, default: 0 },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    async handle(args: ToolArgs) {
      const urls = urlList(args);
      // Checked here as well as by the schema: a host handed no URL would launch nothing and say
      // nothing, and an agent reads that as "researched".
      if (urls.length === 0 || urls.length > UI_RESEARCH_LIMITS.urls) {
        throw new McpArgsInvalidError({
          name: 'ui.research',
          issues: [`urls must list 1 to ${String(UI_RESEARCH_LIMITS.urls)} URLs`],
        });
      }
      const follow = Math.min(UI_RESEARCH_LIMITS.follow, Math.max(0, count(args, 'follow', 0)));
      return jsonResult(await host.researchDesign({ urls, follow }));
    },
  };
}
