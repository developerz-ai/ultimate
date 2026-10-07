// The ONE declaration of a primitive's `mcp` block, and the one answer to "did this primitive opt
// into being an MCP tool?" — a literal `expose: true`. Core owns both because the block's readers
// span tiers 3-5 — `action`, `query`, `mcp`, `ai`, `manifest` — and this is the only tier all of
// them reach. `ActionMcp`, `QueryMcp` and `McpExposure` each restated the block until 25.0.0.

/**
 * MCP's four tool hints, as the spec (2025-06-18) spells them. Hints for a client's confirmation
 * UI — the primitive's `policy` decides every call whatever they say.
 */
export interface McpAnnotationHints {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One comparison a list filter accepts. A filter key is `<field><op>`: `status_eq`. */
export type McpListFilterOp = '_eq' | '_in' | '_gt' | '_lt' | '_cont';

/**
 * The list whitelist an MCP meta surface composes over: `filters` field → operators, sortable
 * `sort` fields, pickable `fields`, `maxLimit`. Flat keys: the query's own `input` declares
 * `status_eq`, `sort`, `fields`, `cursor`, `limit` and implements them; `manage_resource` refuses
 * anything outside the whitelist before it runs.
 */
export interface McpListParams {
  readonly filters?: Readonly<Record<string, readonly McpListFilterOp[]>>;
  readonly sort?: readonly string[];
  readonly fields?: readonly string[];
  /** Ceiling for `limit`. `@ultimat3/mcp`'s `DEFAULT_LIST_MAX_LIMIT` when absent. */
  readonly maxLimit?: number;
}

/**
 * `mcp: { … }` on an `action`, a `mutator`, a `query` or an `llm()`/`agent()` factory — the block
 * an author writes and `@ultimat3/mcp`'s `toolFrom` reads. An action's view omits `listParams`
 * (it has no list to compose); every other field means the same on every primitive.
 */
export interface McpExposureDeclaration {
  /** Opt-in: only a literal `true` makes the primitive a tool. Silence exposes nothing. */
  readonly expose: boolean;
  /**
   * Contract text, NOT UI text — deliberately outside `t()`. It becomes the OpenAPI operation
   * `summary`, and `buildOpenApi`'s bytes are what `x verify` diffs for contract drift. Resolving
   * it through the ambient, request-scoped translator would make `openapi.json` depend on
   * whichever locale was active when it was generated. Two ways to describe one tool is the
   * drift axiom 1 rejects, so there is no localised twin here.
   */
  readonly description?: string;
  /**
   * Roles that may SEE the projected tool. A CATALOG audience, never an authz rule — the `policy`
   * still decides every call. Fail-closed where it lands: a caller whose role is not named,
   * including one with no role at all, gets the answer an ABSENT tool gets, never `Forbidden`,
   * which would confirm the tool exists. A plain role list, never a predicate: a declared fact
   * stays static and serialisable. Omitted means every caller may enumerate it.
   */
  readonly visibleTo?: readonly string[];
  /** The tool's display name in an MCP client's UI. Contract text, like `description`. */
  readonly title?: string;
  /**
   * Overrides of the hints `@ultimat3/mcp` derives, key by key: an action derives
   * `readOnlyHint: false`, `destructiveHint: true` and `idempotentHint` from `idempotent`; a query
   * `readOnlyHint: true`. `annotations: { destructiveHint: false }` for a write that destroys
   * nothing, `openWorldHint: true` for one that reaches outside the app.
   */
  readonly annotations?: McpAnnotationHints;
  /** A list query's whitelist, carried to the tool for the meta surface. Never an action's. */
  readonly listParams?: McpListParams;
}

/**
 * Opt-in, never opt-out: silence exposes nothing. An absent block, an omitted `expose` and a
 * literal `false` are one answer, because a tool the author never asked for is a capability
 * handed to every agent that can reach the surface — and writing an action is not a request to
 * hand one out.
 *
 * Read through `Partial<Pick<…>>` because a reader holding only a descriptor (`manifest`'s
 * diff, a hand-built test primitive) may carry no `expose` at all, and that is the same "no".
 *
 * Six readers decided it three ways until 2026-08: `=== true` where a tool is actually built,
 * `!== false` in the OpenAPI hint and `?? true` in the manifest fact. So an action with no `mcp`
 * block was published as a tool by the contract and refused by every surface that could have
 * called one.
 *
 * The one deliberate exception is `@ultimat3/admin`'s OWN catalog, whose every tool is already
 * gated on an admin permission and whose CRUD tools carry no `mcp` block at all; there
 * `expose: false` withdraws a tool. That surface says so in `mcp-tools.ts` and in
 * `wiki/Admin-Dashboard.md`. Nothing else may grow a second default.
 */
export function isMcpExposed(
  declared: Partial<Pick<McpExposureDeclaration, 'expose'>> | undefined,
): boolean {
  return declared?.expose === true;
}
