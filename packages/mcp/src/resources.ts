// MCP resources and prompts: the read-only documents an agent pulls once and keeps.
//
// Resources are what stops an agent guessing. Rather than teaching it the framework in a
// prompt, hand it the generated facts at a stable URI and let it read them. Providers are
// injected as thunks because `@ultimat3/manifest` and `@ultimat3/render` sit in this same
// tier — the CLI wires them, this package only defines the shape and the URIs.

import type { JsonSchema } from './wire';

/** Stable URIs. These are quoted in AGENTS.md files, so treat them as public API. */
export const RESOURCE_URIS = {
  manifest: 'ultimate://manifest',
  openapi: 'ultimate://openapi.json',
  routes: 'ultimate://routes',
  schema: 'ultimate://schema',
} as const;

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  /** Read on demand — a resource is never eagerly materialised at boot. */
  read(): Promise<string> | string;
}

/** `resources/list` row (the MCP shape, minus the body). */
export interface ResourceListEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** `resources/read` contents entry. */
export interface ResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/** A versioned prompt the server offers to clients (`prompts/list`). */
export interface McpPrompt {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly McpPromptArgument[];
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

/**
 * A prompt may be authored as a path to a versioned prompt artifact
 * (`apps/web/app/posts/prompts/summarize.v3.md`). The file IS the contract, so restating its
 * name and description in a second place is exactly the duplication that goes stale — the name
 * comes from the filename, version suffix included, because `summarize.v2` and `summarize.v3`
 * are two different prompts and an agent must be able to say which one it read.
 */
export function promptFromPath(path: string): McpPrompt {
  const file = path.split('/').pop() ?? path;
  const name = file.replace(/\.(md|markdown|txt|prompt)$/i, '');
  return { name, description: `Versioned prompt artifact: ${path}` };
}

/** Accepts either authoring form; an object is already the wire shape and passes through. */
export function toPrompts(prompts: readonly (string | McpPrompt)[]): readonly McpPrompt[] {
  return prompts.map((prompt) => (typeof prompt === 'string' ? promptFromPath(prompt) : prompt));
}

/** The four documents every Ultimate app publishes. Any provider may be omitted. */
export interface FrameworkResourceProviders {
  /** `x.manifest.json` contents — the generated facts. */
  readonly manifest?: () => Promise<string> | string;
  /** The OpenAPI document projected from actions and queries. */
  readonly openapi?: () => Promise<string> | string;
  /** The route table: URL, render mode, offline strategy, budget. */
  readonly routes?: () => Promise<string> | string;
  /** Entity/column/invariant description — the DB shape as JSON. */
  readonly schema?: () => Promise<string> | string;
}

export function frameworkResources(providers: FrameworkResourceProviders): readonly McpResource[] {
  const out: McpResource[] = [];
  if (providers.manifest !== undefined) {
    out.push({
      uri: RESOURCE_URIS.manifest,
      name: 'x.manifest.json',
      description: 'Generated facts: routes, entities, actions, queries, jobs, policies.',
      mimeType: 'application/json',
      read: providers.manifest,
    });
  }
  if (providers.openapi !== undefined) {
    out.push({
      uri: RESOURCE_URIS.openapi,
      name: 'openapi.json',
      description: 'OpenAPI 3.1 document projected from every action and query.',
      mimeType: 'application/json',
      read: providers.openapi,
    });
  }
  if (providers.routes !== undefined) {
    out.push({
      uri: RESOURCE_URIS.routes,
      name: 'routes',
      description: 'Route table: url, render mode, offline strategy, hydrate, budget.',
      mimeType: 'application/json',
      read: providers.routes,
    });
  }
  if (providers.schema !== undefined) {
    out.push({
      uri: RESOURCE_URIS.schema,
      name: 'schema',
      description: 'Entities with columns, types and invariants.',
      mimeType: 'application/json',
      read: providers.schema,
    });
  }
  return out;
}

export class ResourceRegistry {
  private readonly resources = new Map<string, McpResource>();

  register(resource: McpResource): this {
    this.resources.set(resource.uri, resource);
    return this;
  }

  registerAll(resources: readonly McpResource[]): this {
    for (const r of resources) this.register(r);
    return this;
  }

  /** Sorted by URI: a stable list is diffable between two boots. */
  list(): readonly ResourceListEntry[] {
    return [...this.resources.values()]
      .map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }))
      .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  }

  async read(uri: string): Promise<ResourceContents | undefined> {
    const resource = this.resources.get(uri);
    if (resource === undefined) return undefined;
    return { uri, mimeType: resource.mimeType, text: await resource.read() };
  }
}

/** JSON Schema for a tool that takes one resource URI — reused by app surfaces. */
export const URI_ARG_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    uri: { type: 'string', description: `Resource URI, e.g. ${RESOURCE_URIS.manifest}` },
  },
  required: ['uri'],
  additionalProperties: false,
};
