// The four refusals that keep a recipe from naming a tool, an argument or a URI that is not there.
// All raised at boot: a stale recipe is a load failure, never an agent following it into nothing.

import { renderCauseValue, UltimateError } from '@ultimat3/core';

export class McpRecipeToolUnknownError extends UltimateError {
  constructor(input: {
    readonly offenders: readonly string[];
    readonly catalog: readonly string[];
  }) {
    super({
      code: 'X_MCP_RECIPE_TOOL_UNKNOWN',
      cause: `a recipe step names a tool this server does not project: ${input.offenders.join('; ')} (the catalog: ${input.catalog.join(', ')})`,
      fix: 'steps: [{ tool: <a name the cause lists>, why }]   # rename step.tool in the recipe the cause names, or expose the tool',
      meta: { offenders: [...input.offenders] },
    });
  }
}

export class McpRecipeExampleInvalidError extends UltimateError {
  constructor(input: { readonly offenders: readonly string[] }) {
    super({
      code: 'X_MCP_RECIPE_EXAMPLE_INVALID',
      cause: `a recipe step's example fails its tool's input: ${input.offenders.join('; ')}`,
      fix: 'example: { … }   # correct step.example in the recipe the cause names; the issues name the field',
      meta: { offenders: [...input.offenders] },
    });
  }
}

export class McpRecipeUnknownError extends UltimateError {
  constructor(input: {
    readonly uri: string;
    readonly code?: string;
    readonly recipes: readonly string[];
  }) {
    super({
      code: 'X_MCP_RECIPE_UNKNOWN',
      cause: `${input.code === undefined ? 'an error' : input.code} links to ${renderCauseValue(input.uri)}, and no endpoint's recipes: serves it (served: ${input.recipes.join(', ') || 'none'})`,
      fix: "recipes: [{ name: '<name>', title, description, steps }]   # add it to defineAppMcp, or drop docs: from the error",
      meta: { uri: input.uri, ...(input.code === undefined ? {} : { errorCode: input.code }) },
    });
  }
}

export class McpRecipeUriReservedError extends UltimateError {
  constructor(input: { readonly uri: string; readonly reason: 'resource' | 'duplicate' | 'name' }) {
    const why =
      input.reason === 'resource'
        ? 'resources: holds it beside recipes:, and docs://recipes/ is owned by recipes:'
        : input.reason === 'duplicate'
          ? 'two recipes share that name'
          : 'a recipe name is lowercase letters, digits and -';
    super({
      code: 'X_MCP_RECIPE_URI_RESERVED',
      cause: `${renderCauseValue(input.uri)}: ${why}`,
      fix: "recipes: [{ name: 'issue-a-credit-note', title, description, steps }]   # one name each, [a-z0-9-]; move a hand-written docs://recipes/ resource here",
      meta: { uri: input.uri },
    });
  }
}

export class McpRecipeLinkDanglingError extends UltimateError {
  constructor(input: {
    readonly offenders: readonly string[];
    readonly recipes: readonly string[];
  }) {
    super({
      code: 'X_MCP_RECIPE_LINK_DANGLING',
      cause: `a recipe links to a docs://recipes/ URI no recipe on this server serves: ${input.offenders.join('; ')} (served: ${input.recipes.join(', ') || 'none'})`,
      fix: 'recipes: [...(await markdownRecipes({ dir })), <the missing recipe>]   # or correct the link in the recipe the cause names',
      meta: { offenders: [...input.offenders] },
    });
  }
}
