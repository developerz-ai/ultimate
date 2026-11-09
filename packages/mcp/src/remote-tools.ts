/**
 * `mcpTools()` — another server's MCP tools as this app's `action`s: a factory over `action`, so a
 * remote tool takes the app's own `policy`, its rate limit, the confirmation gate and a manifest row,
 * and an agent sees one tool list. Nothing is discovered at run time: `allow` names the tools, the
 * committed `tools.lock.json` holds what a person reviewed, and the live server must still agree.
 */

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Clock } from '@ultimat3/core';
import { finiteCount, systemClock, throwIfAborted } from '@ultimat3/core';
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
  /**
   * Whether this app's OWN MCP surface (`include: 'exposed'`) and its in-app `agent()`s are offered
   * these tools. Default `false`: an app that exposes them republishes a third party's tools on its
   * own `/mcp` — a proxy, under the app's name and token. Opt in per remote server.
   */
  readonly expose?: boolean;
  /**
   * How long one verdict against the live server stands, in milliseconds. A remote that changes and
   * announces nothing is held to the lock again once this has passed. Default 3,600,000 (an hour).
   */
  readonly reverifyMs?: number;
  /** Where the re-verify window reads time. Default core's `systemClock`. */
  readonly clock?: Clock;
}

/** One hour: a remote that changes silently is caught within it, not at the next restart. */
const DEFAULT_REVERIFY_MS = 3_600_000;

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
  const reverifyMs = finiteCount(
    'mcpTools',
    'reverifyMs',
    def.reverifyMs ?? DEFAULT_REVERIFY_MS,
    1,
  );
  const clock = def.clock ?? systemClock;
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
  // Checked against the live server before the first call goes out, again on every announced change
  // (`onToolsChanged`), and again once a verdict is `reverifyMs` old.
  let verified: Promise<readonly RemoteTool[]> | undefined;
  let verifiedAt = 0;
  const check = (options: { readonly signal?: AbortSignal } = {}) => {
    if (verified !== undefined && clock.monotonic() - verifiedAt >= reverifyMs)
      verified = undefined;
    if (verified === undefined) verifiedAt = clock.monotonic();
    // SHARED, so it carries no caller's signal: one caller leaving must not reject every caller
    // that joined it. Bounded by the client's own `deadlineMs`; each caller races its own signal.
    verified ??= client.listTools().then((live) => {
      assertLocked(def.name, locked, def.url, def.allow, live);
      return live;
    });
    // A failed check is not remembered: the next call asks again.
    verified.catch(() => {
      verified = undefined;
    });
    return options.signal === undefined ? verified : raced(verified, options.signal);
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
        expose: def.expose === true,
        // This app's own agents may use what it declared, published or not.
        agents: true,
        // The LOCKED description, never the live one: what the model reads is what was reviewed.
        description: `[remote ${def.name}] ${entry.description}`,
        annotations: {
          readOnlyHint: entry.readOnly,
          destructiveHint: !entry.readOnly,
          openWorldHint: true,
        },
      },
      async handle({ input, ctx }) {
        await check({ signal: ctx.signal }).catch((error: unknown) => {
          // The caller left: core's `X_ABORTED`, never the signal's raw reason.
          throwIfAborted(ctx);
          throw error;
        });
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

/** Invisible format characters (zero-width space, word joiner, bidi marks): they split a tag. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** `<`, and the two brackets a model reads as one: full-width `＜` and small `﹤`. */
const OPENERS = /[<\uFF1C\uFE64]/g;

/**
 * The remote's words inside a fence a model is told not to obey. Every bracket in the text is
 * escaped (`&lt;`) after the format characters are stripped — no tag-shaped pattern to match, so
 * no spelling of `</untrusted>` (case, whitespace, a zero-width space, a full-width `＜`) can end
 * the fence early and speak as the app, or open a forged one naming another source.
 */
export function delimit(source: string, text: string, max: number): string {
  const body = truncate(text, max).replace(FORMAT_CHARS, '').replace(OPENERS, '&lt;');
  return `<untrusted source="${source}">\n${body}\n</untrusted>`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(1, Math.floor((max - 40) / 2));
  return `${text.slice(0, keep)}\n…[${String(text.length - keep * 2)} characters cut]…\n${text.slice(-keep)}`;
}

/** `shared`, or the caller's own abort — whichever settles first; the shared promise runs on. */
function raced<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const leave = () => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', leave);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
}
