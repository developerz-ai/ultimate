// What `mcpServer(input)` takes. Split from `server.ts` for the size ceiling only: it declares,
// and decides nothing.

import type { Clock, ErrorAudience } from '@ultimat3/core';
import type { McpAuditHook } from './audit-hook';
import type { McpCatalogDetail } from './meta-catalog-render';
import type { McpSplitOptions } from './meta-split-options';
import type { McpResourceGroups, McpSurfaceOption } from './meta-surface';
import type { AnyMcpTool } from './registry';
import type { McpPrompt, McpResource, McpResourceSource } from './resources';
import type { McpCatalogSource } from './server-catalog';
import type { McpInstructions } from './server-voice';
import type { McpTenant } from './tenant';
import type { ServerInfo } from './wire';

export interface McpServerInput {
  readonly tools?: readonly AnyMcpTool[];
  readonly resources?: readonly McpResource[];
  /** Resources listed per caller (a tenant's own docs), after the fixed ones. */
  readonly resourceSources?: readonly McpResourceSource[];
  readonly prompts?: readonly McpPrompt[];
  readonly serverInfo?: ServerInfo;
  /** `'flat'` (the default): one tool per primitive. See `McpSurfaceOption`. */
  readonly surface?: McpSurfaceOption | undefined;
  /** The meta catalog's resources. Required with a surface that can be `'meta'`. */
  readonly groups?: McpResourceGroups | undefined;
  /**
   * How much of each action `list_resources` says: `'full'` (the default) or `'compact'` — names
   * and tags, the rest in `describe_resource`. Needs a surface that can be `'meta'`.
   */
  readonly catalogDetail?: McpCatalogDetail | undefined;
  /**
   * `initialize`'s `instructions`: how to use this server, for a client that injects it into the
   * model's context (Claude Code does; many clients do not — never load-bear on it). A function
   * answers per caller population — a staff surface and a customer one read different advice —
   * and a function that throws or answers anything but a non-empty string sends none.
   */
  readonly instructions?: McpInstructions | undefined;
  /**
   * Whose `fix:` line a refusal carries. `'developer'` (the default, and the dev server's): the
   * fix the author wrote — `x policy explain …`, a declaration to edit. `'caller'`: the error's
   * `callerFix` where it declares one — what a REMOTE agent can do about it. `defineAppMcp`
   * serves `'caller'`.
   */
  readonly errorAudience?: ErrorAudience | undefined;
  /** Every gate decision as data, after its log line — see `audit-hook.ts`. The route reads it too. */
  readonly onAudit?: McpAuditHook | undefined;
  /** Stamps each `onAudit` event's `at`. */
  readonly clock?: Clock | undefined;
  /**
   * The per-caller catalog, resolved per request for `tools/list` and every `tools/call` and merged
   * with `tools`/`groups` (`server-catalog.ts`). `defineAppMcp({ catalog })` builds it.
   */
  readonly catalog?: McpCatalogSource | undefined;
  /** One token across tenants, the tenant named per call — see `tenant.ts`. */
  readonly tenant?: McpTenant | undefined /**
   * What the app adds to the `'meta-split'` dispatchers: envelope fields of its own, and the
   * `stricter` hook — see `meta-split-options.ts`. Needs a surface that can be `'meta-split'`.
   */;
  readonly split?: McpSplitOptions | undefined;
}
