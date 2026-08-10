// The tool catalog and the first two of the three security outcomes every MCP surface owes
// a caller. See `docs/architecture/11-ai-surface.md` § Security posture.
//
// OUTCOME 1 — hidden (role). A tool whose `visibleTo` excludes the caller is omitted from
// `tools/list` and answers ToolNotFound (`-32601`) on call, with the same message an absent
// tool gets. Never Forbidden: "Forbidden" confirms the tool exists, which turns an authz
// boundary into a catalog an agent can enumerate by probing. Hidden ≠ Forbidden.
//
// OUTCOME 2 — scope (capability). A tool the caller may SEE but whose `scope` its token does
// not carry is refused (`-32600`, `X_MCP_SCOPE_DENIED`). Being refused is correct here: the
// caller was shown the tool, so naming it leaks nothing, and the message can say which scope
// to obtain — hiding it would strand a well-behaved client that can legitimately fix this.
//
// OUTCOME 3 — policy (`X_FORBIDDEN`) belongs to the tool's own `handle`, which reaches
// `guard()` in @ultimat3/action. It is deliberately NOT here: the scope gate must decide
// before any policy runs against attacker-supplied input.
//
// The outcomes are orthogonal on purpose. A tool can be visible and still refused for a
// narrow token; a token holding every scope still cannot see a tool its role may not.

import type { Actor } from '@ultimat3/core';
import type { ArgIssue } from './validate-args';
import { validateArgs } from './validate-args';
import type { JsonSchema } from './wire';

/** Arbitrary role identifier — apps own their role vocabulary, the framework does not. */
export type McpRole = string;

/**
 * The resolved caller behind one MCP request. `actor` is the framework-wide authz subject
 * (`kind: 'agent'` for a token-authenticated agent) and is what a projected action hands
 * to `policy` — which is why an MCP call and an HTTP call reach the same decision.
 */
export interface McpCaller {
  readonly actor: Actor;
  /** Token scopes, checked by string membership against a tool's `scope`. */
  readonly scopes: ReadonlySet<string>;
  /** Absent = no role filter applies (the caller sees every unrestricted tool). */
  readonly role?: McpRole;
}

/**
 * Who may see a tool: a role list, or a predicate over the caller for a surface that derives
 * visibility from something richer than a role name (`@ultimat3/admin` derives it from the
 * actor's admin permissions).
 *
 * The predicate takes `McpCaller` and nothing else — it structurally CANNOT see call
 * arguments, which is what makes "visibility is input-independent" an invariant rather than a
 * convention. Two calls with different arguments therefore cannot reveal a tool's existence.
 *
 * Declarations (`mcp: { visibleTo: [...] }` on an action) stay a plain role list: a declared
 * fact has to be static and serialisable for the manifest.
 */
export type McpVisibility = readonly McpRole[] | ((caller: McpCaller) => boolean);

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'resource'; readonly uri: string; readonly mimeType?: string };

/**
 * `tools/call` result. `isError` flags an EXPECTED tool-level failure (a policy denied the
 * action, a queue was unreachable) so the model sees it as an outcome to reason about.
 * Malformed requests and unknown methods are JSON-RPC errors instead.
 */
export interface McpToolResult {
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
}

export type ToolArgs = Record<string, unknown>;

export interface McpTool<A extends ToolArgs = ToolArgs> {
  readonly name: string;
  readonly description: string;
  /** The only argument contract. Handed verbatim to the agent by `tools/list`. */
  readonly inputSchema: JsonSchema;
  /** Required scope. Absent = no scope gate (the tool's own policy is the gate). */
  readonly scope?: string;
  /** Who may see and call this tool. Absent = everyone. See `McpVisibility`. */
  readonly visibleTo?: McpVisibility;
  /**
   * Marks a tool that changes state. Drives the transport's rate-limit bucket and is
   * asserted by tests over the dev server, so a new mutating tool cannot be metered as
   * cheap read chatter by omission.
   */
  readonly destructive?: boolean;
  // Method syntax (not a property) so a tool declared with narrower args stays assignable.
  handle(args: A, caller: McpCaller): Promise<McpToolResult>;
}

export type AnyMcpTool = McpTool<ToolArgs>;

/** One `tools/list` row — complete and standalone, no follow-up fetch required. */
export interface ToolListEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** Rate-limit class of a call. Derived from `destructive`, never declared twice. */
export type McpVerbClass = 'read' | 'write';

/**
 * True when `caller` may see (and therefore call) `tool`. See OUTCOME 1 above.
 *
 * FAIL-CLOSED, three ways:
 *
 *  1. A role list admits only the roles it names, so a caller with no role matches none of
 *     them. The opposite — treating "no role" as "no filter applies" — hands an unroled
 *     connection every restricted tool in the catalog.
 *  2. A predicate must return the literal `true`. Author-supplied code returning something
 *     merely truthy ("admin", 1, an object) would otherwise widen the gate by accident.
 *  3. A predicate that THROWS denies. A predicate is app code that can fail for ordinary
 *     reasons (`@ultimat3/admin` builds a request context inside its own), and an escaping
 *     throw would answer `-32603` where a hidden tool answers `-32601` — a different error
 *     code is exactly what a prober reads as "this tool exists", which is the enumeration
 *     oracle OUTCOME 1 exists to remove. It would also break `list` outright for that
 *     caller, turning one broken audience into an empty catalog.
 */
export function visibleToCaller(tool: AnyMcpTool, caller: McpCaller): boolean {
  const visibility = tool.visibleTo;
  if (visibility === undefined) return true;
  if (typeof visibility === 'function') {
    try {
      return visibility(caller) === true;
    } catch {
      return false;
    }
  }
  return caller.role !== undefined && visibility.includes(caller.role);
}

/** The outcome of the two gates plus validation, before a tool runs. */
export type ToolResolution =
  | { readonly kind: 'ok'; readonly tool: AnyMcpTool; readonly args: ToolArgs }
  | { readonly kind: 'not-found'; readonly name: string }
  | { readonly kind: 'scope-denied'; readonly name: string; readonly scope: string }
  | { readonly kind: 'invalid-args'; readonly name: string; readonly issues: readonly ArgIssue[] };

export class ToolRegistry {
  private readonly tools = new Map<string, AnyMcpTool>();

  register(tool: AnyMcpTool): this {
    if (this.tools.has(tool.name)) {
      throw new McpDuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly AnyMcpTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  /** Raw lookup with NO gate applied — the resolver owns the gates. */
  get(name: string): AnyMcpTool | undefined {
    return this.tools.get(name);
  }

  /**
   * `tools/list` payload, role-filtered and name-sorted. Sorted because an agent diffs
   * this catalog between runs and map insertion order is not a contract.
   */
  list(caller?: McpCaller): readonly ToolListEntry[] {
    const all = [...this.tools.values()];
    const visible = caller === undefined ? all : all.filter((t) => visibleToCaller(t, caller));
    return visible
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  names(caller?: McpCaller): readonly string[] {
    return this.list(caller).map((t) => t.name);
  }

  /**
   * Both gates then validation, in the only order that is safe:
   *   1. visibility → not-found     (never reveals existence)
   *   2. scope      → scope-denied  (safe: the caller was already shown the tool)
   *   3. args       → invalid-args
   *   4. policy     → inside `tool.handle`, which is why it is not here
   * Validating before the gates would leak a schema to a caller that may not see the tool;
   * running the policy before the scope gate would decide a refusal from attacker-supplied
   * input. Absent and hidden collapse into ONE branch so the two cannot drift apart.
   */
  resolve(name: string, rawArgs: unknown, caller: McpCaller): ToolResolution {
    const tool = this.tools.get(name);
    if (tool === undefined || !visibleToCaller(tool, caller)) {
      return { kind: 'not-found', name };
    }
    if (tool.scope !== undefined && !caller.scopes.has(tool.scope)) {
      return { kind: 'scope-denied', name, scope: tool.scope };
    }
    const validation = validateArgs(tool.inputSchema, rawArgs ?? {});
    if (!validation.ok) return { kind: 'invalid-args', name, issues: validation.issues };
    return { kind: 'ok', tool, args: validation.value };
  }

  /**
   * Rate-limit class of a call WITHOUT running it. Fail-closed: an unknown tool bills the
   * strict bucket, because a probing client must never get the cheap one.
   */
  verbClass(name: string): McpVerbClass {
    const tool = this.tools.get(name);
    if (tool === undefined) return 'write';
    return tool.destructive === true ? 'write' : 'read';
  }
}

/** Registration is a boot-time programming error, so it throws rather than returning. */
class McpDuplicateToolError extends Error {
  constructor(name: string) {
    super(`MCP tool already registered: ${name}`);
    this.name = 'McpDuplicateToolError';
  }
}

/** Convenience constructor for a one-block text result. */
export function textResult(text: string, isError = false): McpToolResult {
  const content: readonly ContentBlock[] = [{ type: 'text', text }];
  // exactOptionalPropertyTypes: attach `isError` only when it is true.
  return isError ? { content, isError: true } : { content };
}

/** JSON payload as a text block — stable 2-space form so an agent can diff two calls. */
export function jsonResult(value: unknown): McpToolResult {
  return textResult(JSON.stringify(value, null, 2));
}
