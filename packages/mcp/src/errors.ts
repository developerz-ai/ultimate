// The X_* codes owned by @ultimat3/mcp. Each carries the exact next command, because the
// caller reading it is usually an agent with no human to ask.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const MCP_ERROR_CODES = [
  'X_MCP_TOOL_UNKNOWN',
  'X_MCP_SCOPE_DENIED',
  'X_MCP_ARGS_INVALID',
  'X_MCP_PROTOCOL',
  'X_MCP_QUERY_REJECTED',
  'X_MCP_NOT_BRANCH_DB',
  'X_MCP_TOOL_UNSAFE',
  'X_MCP_TOOL_UNDECLARED',
  'X_MCP_TOOL_DUPLICATE',
  'X_MCP_RESOURCE_DUPLICATE',
  'X_MCP_SCOPE_UNKNOWN',
  'X_MCP_SCOPE_CONFLICT',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_ERROR_TITLES: Readonly<Record<McpErrorCode, string>> = {
  X_MCP_TOOL_UNKNOWN: 'no such tool for this caller',
  X_MCP_SCOPE_DENIED: "the connection's token does not carry the tool's scope",
  X_MCP_ARGS_INVALID: 'tool arguments failed the input schema',
  X_MCP_PROTOCOL: 'the MCP handshake or auth is wrong',
  X_MCP_QUERY_REJECTED: 'db.query was not given one read-only statement',
  X_MCP_NOT_BRANCH_DB: 'db.migrate was aimed at a database that is not a branch',
  X_MCP_TOOL_UNSAFE: 'an MCP tool declares no policy',
  X_MCP_TOOL_UNDECLARED: 'defineAppMcp lists a primitive that declares no MCP exposure',
  X_MCP_TOOL_DUPLICATE: 'two primitives project to one MCP tool name',
  X_MCP_RESOURCE_DUPLICATE: 'two resources claim one MCP resource URI',
  X_MCP_SCOPE_UNKNOWN: 'defineAppMcp scopes a tool this server does not project',
  X_MCP_SCOPE_CONFLICT: 'two scopes claim one MCP tool',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(MCP_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

/**
 * OUTCOME 1 of three: a tool name reached the dispatcher that no VISIBLE tool answers to —
 * the tool is absent, or it exists and this caller's role may never invoke it. One error for
 * both, on purpose. Thrown by in-process callers; over the wire the same condition is
 * `-32601` with the same message, so a role-hidden tool is indistinguishable from an absent
 * one even for a caller holding every scope in the system.
 */
export class McpToolUnknownError extends UltimateError {
  constructor(input: { name: string; visible: readonly string[] }) {
    super({
      code: 'X_MCP_TOOL_UNKNOWN',
      cause: `no MCP tool named "${input.name}" is visible to this caller (visible: ${
        input.visible.length > 0 ? input.visible.join(', ') : 'none'
      })`,
      fix: 'call tools/list to read the catalog this caller may use',
    });
  }
}

/**
 * OUTCOME 2 of three: the caller may SEE the tool, but the connection's token does not carry
 * its scope. Named out loud rather than hidden — the caller can legitimately fix this, and
 * hiding it would strand a well-behaved client. Scope belongs to the token, not to the
 * actor's permissions: granting it takes effect on the next connection, not this one.
 */
export class McpScopeDeniedError extends UltimateError {
  readonly scope: string;

  /**
   * `subject` names WHICH surface refused, because the two are declared in different places: a
   * tool's scope comes from `defineAppMcp({ scopes })`, a resource's is a field on the resource.
   * A fix line naming the wrong declaration is an instruction that cannot be followed.
   */
  constructor(input: { name: string; scope: string; subject?: 'tool' | 'resource' }) {
    const subject = input.subject ?? 'tool';
    super({
      code: 'X_MCP_SCOPE_DENIED',
      cause: `${subject} "${input.name}" requires scope "${input.scope}", which this connection's token does not carry`,
      fix:
        subject === 'tool'
          ? `reconnect with a token whose scopes include "${input.scope}" — the app's resolveToken(token) is what returns them — or drop "${input.scope}" from defineAppMcp({ scopes }); scopes are fixed for the life of a connection`
          : `reconnect with a token whose scopes include "${input.scope}" — the app's resolveToken(token) is what returns them — or drop scope: '${input.scope}' from the resource declaring "${input.name}"; scopes are fixed for the life of a connection`,
    });
    this.scope = input.scope;
  }
}

/** Arguments failed the tool's declared JSON Schema — the schema the agent was handed. */
export class McpArgsInvalidError extends UltimateError {
  constructor(input: { name: string; issues: readonly string[] }) {
    super({
      code: 'X_MCP_ARGS_INVALID',
      cause: `arguments for "${input.name}" are invalid: ${input.issues.join('; ')}`,
      fix: `re-read the tool's inputSchema from tools/list and resend`,
    });
  }
}

/**
 * A hand-written tool reached `defineAppMcp` with no policy. Boot-time, because a server that
 * starts and then refuses every call is indistinguishable from one that is merely broken —
 * and a tool that starts and then allows every call is a second door into the data.
 */
export class McpToolUnsafeError extends UltimateError {
  constructor(input: { name: string }) {
    super({
      code: 'X_MCP_TOOL_UNSAFE',
      cause: `tool "${input.name}" declares no policy; an unguarded tool is a second door into the data`,
      fix: `add policy: '<resource>:<verb>' to the tool, reusing the permission its action uses`,
    });
  }
}

/**
 * A primitive was NAMED in `defineAppMcp`'s `actions`/`queries` but never declared
 * `mcp: { expose: true }`. Naming it there is the request to expose it, so the only two honest
 * answers are "project it" and "refuse": filtering it out silently ships a catalog missing a tool
 * its author believes is in it, and nothing fails until an agent asks for a tool that is not
 * there. Boot-time, with every offender named at once so one edit closes all of them.
 *
 * `include: 'exposed'` sweeps the registries and therefore DOES filter — that list is every
 * primitive the app registered, not a list anyone wrote out.
 */
export class McpToolUndeclaredError extends UltimateError {
  /** The offending primitive names, so a caller can report them without re-parsing `cause`. */
  readonly names: readonly string[];

  constructor(input: { names: readonly string[] }) {
    const names = input.names.join(', ');
    super({
      code: 'X_MCP_TOOL_UNDECLARED',
      cause: `listed in defineAppMcp but never declared mcp.expose: ${names}`,
      fix:
        "add mcp: { expose: true, description: '<what it does>' } beside the policy on each — " +
        "or drop it from the list and let include: 'exposed' project what opted in",
    });
    this.names = input.names;
  }
}

/**
 * Two primitives project to one tool name. Caught at boot rather than at first call: an agent
 * asking for the name reaches whichever copy won, which is the worst failure mode available —
 * a call that succeeds against the wrong handler and reports nothing.
 */
export class McpToolDuplicateError extends UltimateError {
  /**
   * Which declaration each copy came from, when the projector knows — carried the way
   * `McpScopeUnknownError` carries `projected`, so a caller can show it without re-parsing
   * `cause`.
   */
  readonly declaredBy: readonly string[];

  constructor(input: { name: string; declaredBy?: readonly string[] | undefined }) {
    // The old `fix:` named "the primitive's export name, or the `tools` record key" for every
    // raiser. On `@ultimat3/admin`'s path the colliding string is an `AdminAction.name` and
    // neither of those exists, so the reader was sent to two places that do not hold it. Where
    // the projector knows the sources, the fix names THEM instead of guessing.
    const sites = input.declaredBy ?? [];
    const from = sites.length > 0 ? ` (declared by ${sites.join(' and ')})` : '';
    super({
      code: 'X_MCP_TOOL_DUPLICATE',
      cause: `two primitives project to the MCP tool "${input.name}"${from}`,
      fix:
        sites.length > 0
          ? `rename one — "${input.name}" is projected by ${sites.join(' and ')}; change the name at one of them`
          : "rename one: the tool name is the primitive's export name, the `tools` record key, or an admin action's `name`",
    });
    this.declaredBy = sites;
  }
}

/**
 * Two resources claim one `ultimate://` URI. The twin of `McpToolDuplicateError`, and refused for
 * the same reason: a URI is quoted in AGENTS.md files, so `resources/read` reaching whichever copy
 * was wired last is a read that succeeds against the wrong document and reports nothing. Silent
 * replacement also made the answer depend on registration order, which is not a contract.
 */
export class McpResourceDuplicateError extends UltimateError {
  constructor(input: { uri: string }) {
    super({
      code: 'X_MCP_RESOURCE_DUPLICATE',
      cause: `two resources are registered at "${input.uri}"; a URI addresses one document`,
      fix: `give one of them its own URI — register({ uri: '${input.uri}-<what-it-is>', … }) — or drop the duplicate registration`,
    });
  }
}

/**
 * `defineAppMcp`'s `scopes:` names a tool the server does not project. Boot-time and loud:
 * the alternative is a scope entry that quietly covers nothing, leaving the tool the author
 * meant to gate reachable by every connection — a gate that reads as declared and never runs.
 * The projected names travel with it, because the usual cause is a rename or a typo.
 */
export class McpScopeUnknownError extends UltimateError {
  /** The catalog as projected, so a caller can show it without re-parsing `cause`. */
  readonly projected: readonly string[];

  constructor(input: { scope: string; name: string; projected: readonly string[] }) {
    const projected = input.projected.length > 0 ? input.projected.join(', ') : 'nothing';
    super({
      code: 'X_MCP_SCOPE_UNKNOWN',
      cause: `scopes["${input.scope}"] names "${input.name}", which this server does not project (projected: ${projected})`,
      fix: `in defineAppMcp, spell it as one of the projected names above — or drop "${input.name}" from scopes["${input.scope}"]`,
    });
    this.projected = input.projected;
  }
}

/**
 * Two scopes claim one tool. A tool carries ONE scope, so the second claim would either
 * overwrite the first or be dropped — decided by object key order, which is not a security
 * model. Refused at boot rather than resolved, because either resolution is a guess about
 * which capability the author meant a token to need.
 *
 * The two claimants travel with it, as `McpScopeUnknownError` carries the projected catalog: the
 * reader is usually an agent holding `--json`, and a sentence is not a field.
 */
export class McpScopeConflictError extends UltimateError {
  /** The two scopes that claimed the tool, in the order the map declared them. */
  readonly scopes: readonly [string, string];

  constructor(input: { name: string; scopes: readonly [string, string] }) {
    super({
      code: 'X_MCP_SCOPE_CONFLICT',
      cause: `tool "${input.name}" is claimed by two scopes ("${input.scopes[0]}" and "${input.scopes[1]}"); a tool carries one`,
      fix: `in defineAppMcp, keep "${input.name}" under the single scope a token must hold for it, and remove the other entry`,
    });
    this.scopes = input.scopes;
  }
}

/** A malformed envelope or an unsupported method — a client bug, not an authz outcome. */
export class McpProtocolError extends UltimateError {
  constructor(input: { cause: string; fix?: string }) {
    super({
      code: 'X_MCP_PROTOCOL',
      cause: input.cause,
      fix: input.fix ?? `send a JSON-RPC 2.0 body: { jsonrpc: '2.0', id, method, params }`,
    });
  }
}

/**
 * LAYER 3 of `db.query`'s four defences: the statement is not one read-only statement, so it
 * never reaches the server. Separate from the migration refusal below because the two want
 * different next commands, and a code that covers both tells the agent neither.
 *
 * The cause is the problem ALONE — no `db.query refused:` frame. The guard has two callers on two
 * surfaces (the MCP tool, and `@ultimat3/admin`'s `/_x` DB panel), and only the caller knows which
 * reader it is talking to: the panel added its own frame and rendered `refused: db.query refused:
 * …`, naming an MCP tool to a developer in a browser who never called one. Nothing is lost —
 * `X_MCP_QUERY_REJECTED`'s TITLE already says `db.query`, and `format()` renders it above the
 * cause, so the tool is named once, by the code, wherever the error surfaces.
 */
export class McpQueryRejectedError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({
      code: 'X_MCP_QUERY_REJECTED',
      cause: input.cause,
      fix: input.fix,
    });
  }
}

/**
 * `db.migrate` was pointed at a database that is not a branch. Enforced, not documented — the
 * dev server holds real credentials, and a migration is the one dev tool that cannot be undone
 * by reading the error afterwards.
 *
 * Unframed for the same reason as the refusal above, and it is the same defect even with one
 * caller today: the title says `db.migrate`, so a `db.migrate refused:` cause said it twice. Two
 * adjacent errors in one file cannot answer "who names the surface" two different ways.
 */
export class McpNotBranchDbError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({
      code: 'X_MCP_NOT_BRANCH_DB',
      cause: input.cause,
      fix: input.fix,
    });
  }
}
