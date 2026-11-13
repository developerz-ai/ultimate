// The repository's own agent harness, read as the harness reads it: every tool an agent or command
// lists exists or is wired in `.mcp.json.example` (`bun run setup` copies it to the gitignored
// `.mcp.json`), the dev MCP server line runs a real `x mcp` flag, every
// allow-listed command is a rule Claude Code can match, every hook names a file that exists, and a
// slash command stays under its byte ceiling.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory native; the ceiling case needs a throwaway repo root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { parse, t } from '@ultimat3/schema';
import { mcpSpec } from '../packages/cli/src/cmd-mcp-spec';
import { COMMAND_CEILING, claudeMdFindings } from './claude-md-size';
import { MCP_EXAMPLE } from './lib/mcp-config';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();

/** Claude Code's own tools an agent or command here may name. */
const BUILT_IN = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'SendMessage',
  'Skill',
  'TodoWrite',
]);

const McpJson = t.object({
  mcpServers: t.record(t.object({ command: t.string, args: t.array(t.string) })),
});

const Settings = t.object({
  permissions: t.object({ allow: t.array(t.string) }),
  hooks: t.record(
    t.array(t.object({ hooks: t.array(t.object({ type: t.string, command: t.string })) })),
  ),
});

const read = async (path: string): Promise<string> => Bun.file(join(ROOT, path)).text();

const mcpServers = async (): Promise<Readonly<Record<string, { args: readonly string[] }>>> =>
  parse(McpJson, JSON.parse(await read(MCP_EXAMPLE)), MCP_EXAMPLE).mcpServers;

/** `tools:` (agents) or `allowed-tools:` (commands) from a markdown file's frontmatter. */
function toolsOf(source: string): readonly string[] {
  const front = source.startsWith('---\n') ? source.slice(4, source.indexOf('\n---', 4)) : '';
  const line = front.split('\n').find((row) => /^(allowed-)?tools:/.test(row));
  if (line === undefined) return [];
  return line
    .slice(line.indexOf(':') + 1)
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
}

async function harnessFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob('.claude/{agents,commands}/*.md');
  return (await Array.fromAsync(glob.scan({ cwd: ROOT, dot: true }))).sort();
}

/** Why `tool` is not available, or undefined when it is. */
function unavailable(tool: string, servers: ReadonlySet<string>): string | undefined {
  if (BUILT_IN.has(tool)) return undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp === null) return `${tool} is no Claude Code tool`;
  return servers.has(mcp[1] ?? '')
    ? undefined
    : `${tool}: no "${mcp[1]}" server in .mcp.json.example`;
}

describe('every tool the harness names exists', () => {
  test('the check refuses an unwired MCP server and an invented tool', () => {
    const servers = new Set(['ultimate-dev']);
    expect(unavailable('mcp__codegraph__codegraph_explore', servers)).toContain('codegraph');
    expect(unavailable('Teleport', servers)).toContain('no Claude Code tool');
    expect(unavailable('mcp__ultimate-dev__*', servers)).toBeUndefined();
  });

  test('every agent and command lists only built-ins and servers .mcp.json.example wires', async () => {
    const servers = new Set(Object.keys(await mcpServers()));
    const files = await harnessFiles();
    expect(files.some((path) => path.startsWith('.claude/agents/'))).toBe(true);
    const missing = [];
    for (const path of files) {
      for (const tool of toolsOf(await read(path))) {
        const why = unavailable(tool, servers);
        if (why !== undefined) missing.push(`${path}: ${why}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every agent names the dev MCP server CLAUDE.md says to ask first', async () => {
    for (const path of (await harnessFiles()).filter((p) => p.startsWith('.claude/agents/'))) {
      expect({ path, has: toolsOf(await read(path)).includes('mcp__ultimate-dev__*') }).toEqual({
        path,
        has: true,
      });
    }
  });
});

describe('.mcp.json.example starts a server that can start', () => {
  test('the dev server runs the in-repo CLI against the reference app, with real flags', async () => {
    const dev = (await mcpServers())['ultimate-dev'];
    if (dev === undefined) expect.unreachable('.mcp.json.example wires no "ultimate-dev" server');
    const [entry, command, sub, ...flags] = dev.args;
    expect(await Bun.file(join(ROOT, entry ?? '')).exists()).toBe(true);
    expect([command, sub]).toEqual(['mcp', 'serve']);
    // `x mcp serve` needs an app (`requiresApp`): at the bare root it answers X_NOT_IN_APP.
    const cwd = flags[flags.indexOf('--cwd') + 1] ?? '';
    expect(await Bun.file(join(ROOT, cwd, 'app.config.ts')).exists()).toBe(true);
    const known = new Set(['cwd', ...(mcpSpec.flags ?? []).map((flag) => flag.name)]);
    const named = flags.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2));
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });
});

/** Why a permission rule cannot match the way it reads, or undefined when it can. */
function badRule(rule: string): string | undefined {
  const inner = /^Bash\((.+)\)$/.exec(rule)?.[1];
  if (inner === undefined) return 'not Bash(<command>)';
  if (inner.indexOf(':*') !== -1 && !inner.endsWith(':*')) return '`:*` only matches at the end';
  // Claude Code matches literally up to the first `*`: one before the subcommand allows the program.
  const [program, sub] = inner.replace(/:\*$/, '').split(' ');
  if ((program ?? '').includes('*') || (sub ?? '').includes('*'))
    return '`*` before the subcommand';
  return undefined;
}

describe('.claude/settings.json', () => {
  test('the rule check refuses what Claude Code would misread', () => {
    expect(badRule('Bash(git:* push)')).toContain(':*');
    expect(badRule('Bash(git * main)')).toContain('subcommand');
    expect(badRule('git status')).toContain('Bash(');
    expect(badRule('Bash(git*:*)')).toContain('subcommand');
    expect(badRule('Bash(git stash list:*)')).toBeUndefined();
    expect(badRule('Bash(git diff:*)')).toBeUndefined();
  });

  test('every allow rule parses', async () => {
    const settings = parse(Settings, JSON.parse(await read('.claude/settings.json')), 'settings');
    const bad = settings.permissions.allow.flatMap((rule) => {
      const why = badRule(rule);
      return why === undefined ? [] : [`${rule}: ${why}`];
    });
    expect(bad).toEqual([]);
  });

  test('every hook names a script that exists', async () => {
    const settings = parse(Settings, JSON.parse(await read('.claude/settings.json')), 'settings');
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const script = /\.claude\/hooks\/[\w.-]+/.exec(command)?.[0];
      expect({ command, exists: await Bun.file(join(ROOT, script ?? '-')).exists() }).toEqual({
        command,
        exists: true,
      });
    }
  });

  test('no hook reads $CLAUDE_FILE_PATHS, which the harness never sets', async () => {
    expect(await read('.claude/settings.json')).not.toContain('CLAUDE_FILE_PATHS');
  });
});

describe('a slash command has a byte ceiling', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const tree = async (command: number): Promise<readonly string[]> => {
    const root = await mkdtemp(join(tmpdir(), 'claude-harness-'));
    roots.push(root);
    await Bun.write(join(root, 'CLAUDE.md'), 'x');
    await Bun.write(join(root, 'packages/a/CLAUDE.md'), 'x');
    await Bun.write(join(root, '.claude/commands/feature.md'), 'x'.repeat(command));
    return (await claudeMdFindings(root, {})).map((finding) => `${finding.code} ${finding.at}`);
  };

  test('at the ceiling passes; one byte over is refused', async () => {
    expect(await tree(COMMAND_CEILING)).toEqual([]);
    expect(await tree(COMMAND_CEILING + 1)).toEqual([
      'X_CLAUDE_MD_OVERSIZE .claude/commands/feature.md',
    ]);
  });

  test('feature.md as committed is under it', () => {
    expect(Bun.file(join(ROOT, '.claude/commands/feature.md')).size).toBeLessThanOrEqual(
      COMMAND_CEILING,
    );
  });
});
