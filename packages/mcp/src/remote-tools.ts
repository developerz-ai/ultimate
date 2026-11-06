/**
 * `mcpTools()` — another server's MCP tools as this app's `action`s: a factory over `action`, so a
 * remote tool takes the app's own `policy`, its rate limit, the confirmation gate and a manifest row,
 * and an agent sees one tool list. Nothing is discovered at run time: `allow` names the tools, the
 * committed `tools.lock.json` holds what a person reviewed, and the live server must still agree.
 */

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import { finiteCount } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import type { KnownPermission } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import type { AnySchema } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { McpClient, RemoteTool } from './remote-client';
import { mcpClient } from './remote-client';
import { assertLocked, readToolsLock } from './remote-lock';
import { schemaFromJson } from './remote-schema';

export interface McpToolsDef {
  /** This server's name in `tools.lock.json`, every cause and each action's name prefix. */
  readonly name: string;
  readonly url: string;
  readonly auth?: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
  /** The remote tools this app uses. Required: a tool nobody named is never offered. */
  readonly allow: readonly string[];
  /**
   * Who may call these tools here: an existing `resource:verb` permission of the APP's, never the
   * remote server's — as a hand-written tool or a `jobTool()` takes one. A permission and not a
   * predicate: the input is the remote's schema, and an app rule reading it would read nothing.
   */
  readonly policy: KnownPermission;
  /** The parsed `tools.lock.json` (`x mcp lock <name>` writes it). */
  readonly lock: unknown;
  readonly dial?: 'public' | 'named';
  readonly deadlineMs?: number;
  /** The longest answer handed to a model; the middle of a longer one is cut. Default 20,000. */
  readonly maxResultChars?: number;
  readonly fetch?: OutboundFetch;
}

/** What a remote tool answers: its text, delimited as untrusted, and whether it reported an error. */
export const RemoteToolOutput = t.object({ untrusted: t.string, isError: t.boolean });

export type RemoteToolAction = Action<AnySchema, typeof RemoteToolOutput>;

export interface McpTools {
  /** One action per allowed tool, keyed by the REMOTE tool's name. */
  readonly tools: ReadonlyMap<string, RemoteToolAction>;
  readonly client: McpClient;
  /** Lists the live server and refuses a drift from the lock — what boot and `verify` call. */
  check(options?: { readonly signal?: AbortSignal }): Promise<readonly RemoteTool[]>;
}

/** One declared remote server, as `x mcp lock` and `--check` read it. */
export interface DeclaredMcpServer {
  readonly name: string;
  readonly url: string;
  readonly allow: readonly string[];
  readonly client: McpClient;
}

const DECLARED = new Map<string, DeclaredMcpServer>();

/** Every `mcpTools()` this process evaluated, by name — the CLI loads the app, then reads this. */
export function declaredMcpServers(): ReadonlyMap<string, DeclaredMcpServer> {
  return DECLARED;
}

export function mcpTools(def: McpToolsDef): McpTools {
  const maxChars = finiteCount('mcpTools', 'maxResultChars', def.maxResultChars ?? 20_000, 1);
  const locked = readToolsLock(def.lock).get(def.name);
  const client = mcpClient({
    name: def.name,
    url: def.url,
    ...(def.dial === undefined ? {} : { dial: def.dial }),
    ...(def.deadlineMs === undefined ? {} : { deadlineMs: def.deadlineMs }),
    ...(def.auth === undefined ? {} : { auth: def.auth }),
    ...(def.fetch === undefined ? {} : { fetch: def.fetch }),
    // The server's list moved: forget the verdict, so the next call re-lists and is held to the
    // lock again — a drift there is `X_MCP_REMOTE_TOOL_CHANGED`, never a quietly new tool.
    onToolsChanged: () => {
      verified = undefined;
    },
  });
  // Recorded BEFORE the lock is judged: `x mcp lock` must find a server whose lock is missing.
  DECLARED.set(def.name, { name: def.name, url: def.url, allow: [...def.allow], client });
  // At declaration: an allowed tool the lock does not hold was never reviewed.
  assertLocked(def.name, locked, def.url, def.allow);
  // Checked against the live server once per process, before the first call goes out.
  let verified: Promise<readonly RemoteTool[]> | undefined;
  const check = (options: { readonly signal?: AbortSignal } = {}) => {
    verified ??= client.listTools(options).then((live) => {
      assertLocked(def.name, locked, def.url, def.allow, live);
      return live;
    });
    // A failed check is not remembered: the next call asks again.
    verified.catch(() => {
      verified = undefined;
    });
    return verified;
  };
  const tools = new Map<string, RemoteToolAction>();
  for (const tool of def.allow) {
    const entry = locked?.tools.get(tool);
    if (entry === undefined) continue;
    const source = `mcp:${def.name}/${tool}`;
    const built = action({
      input: schemaFromJson(entry.inputSchema),
      output: RemoteToolOutput,
      policy: can(def.policy),
      mcp: {
        expose: true,
        // The LOCKED description, never the live one: what the model reads is what was reviewed.
        description: `[remote ${def.name}] ${entry.description}`,
        annotations: {
          readOnlyHint: entry.readOnly,
          destructiveHint: !entry.readOnly,
          openWorldHint: true,
        },
      },
      async handle({ input, ctx }) {
        await check({ signal: ctx.signal });
        const args = typeof input === 'object' && input !== null ? input : {};
        const answer = await client.callTool(tool, args as Record<string, unknown>, {
          signal: ctx.signal,
        });
        return { untrusted: delimit(source, answer.text, maxChars), isError: answer.isError };
      },
    }).named(actionNameFor(def.name, tool));
    tools.set(tool, built);
  }
  return { tools, client, check };
}

/** `docs` + `fetch-page` → `docs_fetch_page`: letters, digits and `_`, as a model's tool name. */
export function actionNameFor(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
}

/**
 * The remote's words inside a fence a model is told not to obey. A closing tag inside the text is
 * broken, so the remote cannot end the fence early and speak as the app.
 */
export function delimit(source: string, text: string, max: number): string {
  const body = truncate(text, max).replaceAll('</untrusted', '<\\/untrusted');
  return `<untrusted source="${source}">\n${body}\n</untrusted>`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(1, Math.floor((max - 40) / 2));
  return `${text.slice(0, keep)}\n…[${String(text.length - keep * 2)} characters cut]…\n${text.slice(-keep)}`;
}
