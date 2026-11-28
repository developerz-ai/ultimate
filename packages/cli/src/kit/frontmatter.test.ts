// Every managed file's front matter, read the way the harness reads it: real YAML, known keys only.
// A key the harness does not know is ignored without a word, and front matter that does not parse
// loads the file with NO fields — a skill with no description is a skill never invoked.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import { kitFiles } from './registry';

const app = names('ledger-demo');

/** Claude Code's SKILL.md keys (code.claude.com/docs/en/skills, as of 2026-11). */
const SKILL_KEYS = new Set([
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
]);

/** Subagent keys (code.claude.com/docs/en/sub-agents, as of 2026-11). */
const AGENT_KEYS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'mcpServers',
  'hooks',
  'maxTurns',
  'skills',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
]);

/** The listing truncates `description` + `when_to_use` past this many characters. */
const DESCRIPTION_MAX = 1_536;
const SKILL_LINES_MAX = 500;

/** The YAML between the first two `---` lines, parsed; a file without them has none. */
export function frontMatter(source: string): Record<string, unknown> | undefined {
  if (!source.startsWith('---\n')) return undefined;
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return undefined;
  const parsed: unknown = Bun.YAML.parse(source.slice(4, end));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : undefined;
}

describe('unit · the front matter check itself', () => {
  test('a colon-space inside a plain description does not parse — the bug it exists for', () => {
    expect(() => frontMatter('---\nname: a\ndescription: it decides: which\n---\n')).toThrow();
  });

  test('a file with no opening fence has no front matter', () => {
    expect(frontMatter('# title\n---\nname: a\n---\n')).toBeUndefined();
  });
});

describe('unit · every managed file has front matter the harness reads', () => {
  for (const file of kitFiles(app)) {
    test(`${file.path}: parses, known keys only, named for its entry`, () => {
      const fields = frontMatter(file.contents);
      if (fields === undefined) return expect.unreachable(`${file.path} has no front matter`);
      const known = file.kind === 'skill' ? SKILL_KEYS : AGENT_KEYS;
      expect(Object.keys(fields).filter((key) => !known.has(key))).toEqual([]);
      expect(fields['name']).toBe(file.name);
      expect(typeof fields['description']).toBe('string');
    });

    test(`${file.path}: description fits the listing and carries no angle bracket`, () => {
      const fields = frontMatter(file.contents) ?? {};
      const listed = `${String(fields['description'] ?? '')}${String(fields['when_to_use'] ?? '')}`;
      expect(listed.length).toBeGreaterThan(40);
      expect(listed.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(listed).not.toMatch(/[<>]/);
    });
  }

  for (const file of kitFiles(app).filter((entry) => entry.kind === 'skill')) {
    test(`${file.path}: under ${SKILL_LINES_MAX} lines, and no accidental $N substitution`, () => {
      expect(file.contents.split('\n').length).toBeLessThanOrEqual(SKILL_LINES_MAX);
      // `$0`, `$1` … expand to the invocation's arguments: a literal one in prose is a bug.
      expect(file.contents.match(/\$\d/g) ?? []).toEqual([]);
    });
  }

  test('design-research activates on the paths a design change touches', () => {
    const skill = kitFiles(app).find((file) => file.name === 'design-research');
    const paths = String(frontMatter(skill?.contents ?? '')?.['paths'] ?? '');
    for (const glob of ['apps/web/site/**', 'packages/ui/**', '**/*.scss'])
      expect(paths.split(', ')).toContain(glob);
  });

  // A skill pre-approves Bash only scoped to the commands it runs — above all design-research,
  // whose input is a stranger's web page. `feature` is the one exception: it coordinates a whole
  // change (tests, generators, git, gh) and a scoped list there is a prompt on every step.
  const BLANKET_BASH_ALLOWED = new Set(['feature']);
  const allowedTools = (source: string): readonly string[] => {
    const value = frontMatter(source)?.['allowed-tools'];
    if (Array.isArray(value)) return value.map(String);
    return typeof value === 'string' ? value.split(/,\s*/) : [];
  };

  test('the allowed-tools reader sees a bare Bash in either spelling', () => {
    const bare = (tools: readonly string[]) => tools.includes('Bash');
    expect(bare(allowedTools('---\nallowed-tools: Read, Bash\n---\n'))).toBe(true);
    expect(bare(allowedTools('---\nallowed-tools:\n  - Read\n  - Bash\n---\n'))).toBe(true);
    expect(bare(allowedTools('---\nallowed-tools:\n  - Bash(bunx x shot:*)\n---\n'))).toBe(false);
  });

  for (const file of kitFiles(app).filter((entry) => entry.kind === 'skill')) {
    test(`${file.path}: Bash is pre-approved only as scoped Bash(<command>:*) rules`, () => {
      const tools = allowedTools(file.contents);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools)
        expect({ tool, ok: /^[A-Z][A-Za-z]*$|^Bash\([^()]+\)$/.test(tool) }).toEqual({
          tool,
          ok: true,
        });
      if (!BLANKET_BASH_ALLOWED.has(file.name)) expect(tools).not.toContain('Bash');
    });
  }

  test('design-research pre-approves exactly the two commands it drives, and no Agent', () => {
    const skill = kitFiles(app).find((file) => file.name === 'design-research');
    expect(allowedTools(skill?.contents ?? '').filter((tool) => tool.startsWith('Bash'))).toEqual([
      'Bash(bunx x design research:*)',
      'Bash(bunx x shot:*)',
    ]);
    expect(allowedTools(skill?.contents ?? '')).not.toContain('Agent');
  });

  test('audit is read-only: its tools write nothing', () => {
    const audit = kitFiles(app).find((file) => file.name === 'audit');
    const tools = String(frontMatter(audit?.contents ?? '')?.['tools'] ?? '').split(', ');
    expect(tools).toContain('Read');
    for (const writer of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
      expect(tools).not.toContain(writer);
  });
});
