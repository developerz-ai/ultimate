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
import { McpToolDuplicateError } from './errors';
import type { McpListParams } from './list-params';
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
  /**
   * The same answer as a JSON object, for a client that consumes it programmatically (MCP
   * 2025-06-18). Set by the projection only when the tool publishes an `outputSchema`, and then it
   * conforms to it; the text block above still carries the serialized JSON for every other client.
   */
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  /**
   * The `X_*` code an `isError` result refused with. AUDIT ONLY — never written to the wire,
   * because the code is already in the rendered body the model reads.
   *
   * A tool that renders its own refusal was otherwise audited `policy-denied` whatever it refused
   * for, so a tool's own ARGUMENT check landed in the bucket a prober's name walk is alerted from.
   * Naming the code sends it through `outcomeForCode`, the classifier a THROWN error already goes
   * through. Absent keeps the conservative reading.
   */
  readonly code?: string;
}

export type ToolArgs = Record<string, unknown>;

/**
 * MCP's tool annotations (2025-06-18), spelled as the spec spells them. HINTS for a client — which
 * calls to confirm with a human, which to retry — never a security boundary: the policy, the scope
 * and the visibility gate decide every call whatever these say.
 *
 * The projection derives them from the primitive (`from-action.ts`); an action or query overrides
 * any of them in its `mcp: { annotations }` block.
 */
export interface McpToolAnnotations {
  /** `true`: the tool changes nothing. A query's default. */
  readonly readOnlyHint?: boolean;
  /**
   * Meaningful only when `readOnlyHint` is false. `true`: it may delete or overwrite. An action's
   * default is `true` — the spec's own default and the safe one: the framework cannot tell an
   * additive write from a destructive one, so a client is told to confirm until the author says
   * otherwise (`annotations: { destructiveHint: false }`).
   */
  readonly destructiveHint?: boolean;
  /** Meaningful only when `readOnlyHint` is false. `true`: a repeat with the same args is a no-op. */
  readonly idempotentHint?: boolean;
  /** `true`: it reaches entities outside this app (mail, a payment provider, the web). */
  readonly openWorldHint?: boolean;
}

export interface McpTool<A extends ToolArgs = ToolArgs> {
  readonly name: string;
  /** Display name for a client's UI (MCP 2025-06-18). Absent: the client shows `name`. */
  readonly title?: string;
  readonly description: string;
  /** The only argument contract. Handed verbatim to the agent by `tools/list`. */
  readonly inputSchema: JsonSchema;
  /**
   * The shape of `structuredContent` (MCP 2025-06-18) — a JSON Schema whose root is an object.
   * Published by `tools/list` only when present; a tool that declares it answers
   * `structuredContent` conforming to it on every successful call.
   */
  readonly outputSchema?: JsonSchema;
  /** See `McpToolAnnotations`. Published by `tools/list` when present. */
  readonly annotations?: McpToolAnnotations;
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
  /**
   * A list query's whitelist of `filters` / `sort` / `fields` / `cursor` + `limit`. Published by
   * `describe_resource` and enforced by `manage_resource` alongside the tool's own input schema;
   * the flat surface ignores it (the tool's `inputSchema` is its contract there).
   */
  readonly listParams?: McpListParams;
  /**
   * A catalog hint: this write answers "awaiting confirmation" and a human finishes it. Shown by
   * `list_resources` so an agent plans for the hand-off; it changes nothing about the call.
   */
  readonly confirms?: boolean;
  /**
   * The tool's policy, decided on the CALLER alone — throws the same denial `handle` would, or
   * returns when the caller may call it (or when only the arguments can decide). The server asks
   * it before answering `invalid-args`, so a caller who may never call this tool gets the 403,
   * never an issue list describing its arguments. Projected actions and queries and app tools
   * carry one; a hand-written tool without it answers `invalid-args` as before.
   */
  admit?(caller: McpCaller): void;
  // Method syntax (not a property) so a tool declared with narrower args stays assignable.
  handle(args: A, caller: McpCaller): Promise<McpToolResult>;
}

export type AnyMcpTool = McpTool<ToolArgs>;

/** One `tools/list` row — complete and standalone, no follow-up fetch required. */
export interface ToolListEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: McpToolAnnotations;
}

/**
 * The `tools/list` row of one tool: every optional member attached only when the tool carries it,
 * so a tool declaring none of them lists exactly the three keys it always did.
 */
export function toolListEntry(tool: AnyMcpTool): ToolListEntry {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
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
export function visibleToCaller(
  // The SUBJECT of the gate, not a tool: a resource carries the same `visibleTo` and owes the same
  // answer, and two implementations of one fail-closed rule is how one of them stops failing
  // closed. Structural, so `AnyMcpTool` and `McpResource` both satisfy it with no adapter.
  subject: { readonly visibleTo?: McpVisibility },
  caller: McpCaller,
): boolean {
  const visibility = subject.visibleTo;
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
  | {
      readonly kind: 'invalid-args';
      readonly name: string;
      readonly issues: readonly ArgIssue[];
      /** The tool the arguments were refused for — asked to `admit` the caller first. */
      readonly tool?: AnyMcpTool;
    };

export class ToolRegistry {
  readonly #tools = new Map<string, AnyMcpTool>();

  register(tool: AnyMcpTool): this {
    if (this.#tools.has(tool.name)) {
      // The SAME code the resource twin throws. One package cannot answer "this name is taken"
      // two ways, and a bare `Error` here reached the CLI as X_CLI_UNEXPECTED with
      // `fix: x doctor --json` — the actual cause discarded at the last hop.
      throw new McpToolDuplicateError({ name: tool.name });
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly AnyMcpTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  /** Raw lookup with NO gate applied — the resolver owns the gates. */
  get(name: string): AnyMcpTool | undefined {
    return this.#tools.get(name);
  }

  /**
   * `tools/list` payload, role-filtered and name-sorted. Sorted because an agent diffs
   * this catalog between runs and map insertion order is not a contract.
   */
  list(caller?: McpCaller): readonly ToolListEntry[] {
    const all = [...this.#tools.values()];
    const visible = caller === undefined ? all : all.filter((t) => visibleToCaller(t, caller));
    return visible
      .map(toolListEntry)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  names(caller?: McpCaller): readonly string[] {
    return this.list(caller).map((t) => t.name);
  }

  /**
   * Both gates then validation, in the only order that is safe:
   *   1. visibility → not-found     (never reveals existence)
   *   2. scope      → scope-denied  (safe: the caller was already shown the tool)
   *   3. args       → invalid-args — unless the tool's `admit` refuses the caller first, which
   *                    the server asks before answering (the policy's actor half, `dispatch`)
   *   4. policy     → inside `tool.handle`, which is why it is not here
   * Validating before the gates would leak a schema to a caller that may not see the tool;
   * running the policy before the scope gate would decide a refusal from attacker-supplied
   * input. Absent and hidden collapse into ONE branch so the two cannot drift apart.
   */
  resolve(name: string, rawArgs: unknown, caller: McpCaller): ToolResolution {
    const tool = this.#tools.get(name);
    if (tool === undefined || !visibleToCaller(tool, caller)) {
      return { kind: 'not-found', name };
    }
    if (tool.scope !== undefined && !caller.scopes.has(tool.scope)) {
      return { kind: 'scope-denied', name, scope: tool.scope };
    }
    const validation = validateArgs(tool.inputSchema, rawArgs ?? {});
    if (!validation.ok) return { kind: 'invalid-args', name, issues: validation.issues, tool };
    return { kind: 'ok', tool, args: validation.value };
  }

  /**
   * Rate-limit class of a call WITHOUT running it. Fail-closed: an unknown tool bills the
   * strict bucket, because a probing client must never get the cheap one.
   */
  verbClass(name: string): McpVerbClass {
    const tool = this.#tools.get(name);
    if (tool === undefined) return 'write';
    return tool.destructive === true ? 'write' : 'read';
  }
}

/** Convenience constructor for a one-block text result. */
export function textResult(text: string, isError = false): McpToolResult {
  const content: readonly ContentBlock[] = [{ type: 'text', text }];
  // exactOptionalPropertyTypes: attach `isError` only when it is true.
  return isError ? { content, isError: true } : { content };
}

/**
 * JSON payload as a text block — COMPACT, one line. Every byte of it lands in the caller's context
 * window and stays there for the rest of the session; the 2-space form this printed until 22.10
 * spent a third of a large answer on indentation (a staff catalog measured 32.5k characters).
 * `JSON.stringify` is deterministic for one value, so two calls still diff.
 *
 * TOTAL, because the value is an app's: `toolFromAction` hands an action's own return value
 * straight here, and `JSON.stringify` answers `undefined` for a handler that returned nothing —
 * a `text` that is not a string is an invalid MCP frame — and THROWS on a bigint, a cycle or a
 * `toJSON` the value carries. A throw would leave the server's catch reporting a bug in the tool
 * for a fault in the rendering, so the unreadable case is an ordinary `isError` result: the same
 * three-line shape every other expected failure comes back as, and one an agent can act on.
 */
export function jsonResult(value: unknown): McpToolResult {
  const text = serialize(value);
  return text === undefined ? UNSERIALIZABLE : textResult(text);
}

/**
 * `jsonResult` plus `structuredContent`, for a tool that publishes an `outputSchema`. The structured
 * copy is the SERIALIZED value read back — never the value itself — so a `Date` is the string the
 * text block carries and a class instance is its JSON, exactly what a client validating against the
 * schema is handed. `wrap` names the key an array answer is published under (`rows` for a query),
 * because MCP's `structuredContent` is an object.
 *
 * An answer whose JSON is not an object (after `wrap`) gets no structured copy: the schema said
 * object, and a structured copy that contradicts its schema is refused by a validating client.
 */
export function structuredResult(value: unknown, wrap?: string): McpToolResult {
  const text = serialize(value);
  if (text === undefined) return UNSERIALIZABLE;
  const parsed: unknown = JSON.parse(text);
  const structured = wrap === undefined ? parsed : { [wrap]: parsed };
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    return textResult(text);
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

const UNSERIALIZABLE: McpToolResult = textResult(
  'the tool ran, but its result is not JSON (a bigint, a cycle, or a toJSON that threw) — the tool has to return a JSON-serialisable value',
  true,
);

/** Compact JSON, `'null'` for a value with no JSON form, `undefined` when serializing threw. */
function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return undefined;
  }
}
