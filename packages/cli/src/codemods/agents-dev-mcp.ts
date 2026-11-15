// 31.22.0: the four `.claude/agents/*.md` the scaffold writes may call the app's dev MCP server
// (`mcp__<app>__*`, the server `.mcp.json` names). Each `tools:` line still as `x new` wrote it
// gains it; one the app changed is the app's choice, and is left as it is.

import { stringField } from '@ultimat3/core';
import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

/** Each agent and the `tools:` line `x new` gave it. */
export const AGENT_TOOLS: Readonly<Record<string, string>> = {
  '.claude/agents/shape.md': 'tools: Read, Glob, Grep, Bash',
  '.claude/agents/data.md': 'tools: Read, Write, Edit, Glob, Grep, Bash',
  '.claude/agents/server.md': 'tools: Read, Write, Edit, Glob, Grep, Bash',
  '.claude/agents/web.md': 'tools: Read, Write, Edit, Glob, Grep, Bash',
};

const appName = (manifest: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return undefined;
  }
  const name = stringField(parsed, 'name');
  return name !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined;
};

export const codemod: Codemod = {
  id: 'agents-dev-mcp',
  since: '31.22.0',
  summary:
    ".claude/agents/*.md may call the app's dev MCP server: mcp__<app>__* on each tools: line",
  async run(app) {
    const name = appName((await app.read('package.json')) ?? '');
    if (name === undefined) return { changed: [], skipped: [] };
    const results = [];
    for (const [path, tools] of Object.entries(AGENT_TOOLS)) {
      // The front matter's own line, newline-bounded, so a longer `tools:` line never matches.
      const edit: SnippetEdit = {
        from: `\n${tools}\n`,
        to: `\n${tools}, mcp__${name}__*\n`,
        optional: true,
      };
      results.push(await editSnippets(app, path, [edit]));
    }
    return mergeResults(results);
  },
};
