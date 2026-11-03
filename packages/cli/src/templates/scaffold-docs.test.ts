// The brain a generated app is born with, held to one thing: it must name the gate the app
// actually has. It named `bun run check` (a build, then `x verify`) until `x verify` learned to
// build what its `budgets` step weighs and the `check` script was deleted (plan 101, 21). A brain
// that names a script the app no longer has is worse than one that names none: it is confidently
// wrong, and the agent's first command fails.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { claudeCommandFiles } from './scaffold-claude-commands';
import { docsFiles } from './scaffold-docs';

const app = names('ledger-demo');

const emitted = (
  files: readonly { path: string; contents: string | Uint8Array }[],
  path: string,
) => {
  const found = files.find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const doc = (path: string): string => emitted(docsFiles(app), path);

describe('unit · the generated brain names bun run verify as the gate', () => {
  // One row, and it is the row an agent reads first. Matched on the row rather than on the file,
  // so a `bun run verify` mentioned three paragraphs down cannot make this pass.
  test("AGENTS.md's gate row is bun run verify, and it says the build is the gate's own", () => {
    const rows = doc('AGENTS.md')
      .split('\n')
      .filter((line) => line.startsWith('| One gate |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('bun run verify');
    expect(rows[0]).toContain('budgets');
  });

  test('no convention file names the deleted check script', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'README.md'])
      expect(doc(path)).not.toContain('bun run check');
    for (const file of claudeCommandFiles(app))
      expect(String(file.contents)).not.toContain('bun run check');
  });

  test("CLAUDE.md's Gate bullet is bun run verify, and points at the CI that runs it", () => {
    const bullet = doc('CLAUDE.md')
      .split('\n')
      .find((line) => line.startsWith('- Gate:'));
    expect(bullet).toContain('bun run verify');
    expect(doc('CLAUDE.md')).toContain('.github/workflows/ci.yml');
  });

  test('/verify runs bun run verify — the command whose whole job is the gate', () => {
    const verify = emitted(claudeCommandFiles(app), '.claude/commands/verify.md');
    const instruction = verify.split('\n').find((line) => line.startsWith('Run '));
    expect(instruction).toBe('Run `bun run verify`.');
  });

  test('/feature reports the same gate it tells the agent to run', () => {
    const feature = emitted(claudeCommandFiles(app), '.claude/commands/feature.md');
    expect(feature).toContain('**Done means `bun run verify` green.**');
    expect(feature).toContain('Gate:       bun run verify');
  });

  test('README.md names bun run verify as the gate', () => {
    const line = doc('README.md')
      .split('\n')
      .find((text) => text.startsWith('bun run verify'));
    expect(line).toContain('the gate');
  });
});

describe('unit · the generated brain speaks to any agent, in commands that run', () => {
  // A stranger's app is not a hosting platform's: two paragraphs about one platform's `.dz/`
  // directory were in every scaffold's AGENTS.md and CLAUDE.md, context spent on a product the
  // author never chose. And `x` is on no PATH in a fresh app, so a bare `x g` is a first command
  // that fails — `bunx x` runs the CLI the app installed.
  test('neither convention file mentions .dz/ or the platform behind it', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(doc(path)).not.toContain('.dz/');
      expect(doc(path)).not.toContain('developerz.ai');
    }
  });

  test('no command is spelled with a bare x', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(doc(path)).not.toMatch(/`x g\b/);
      expect(doc(path)).not.toMatch(/`x [a-z]/);
      expect(doc(path)).toContain('`bunx x g ');
    }
  });

  test('AGENTS.md has an Agent tools block naming .mcp.json, the manifest and the workflows', () => {
    const text = doc('AGENTS.md');
    const block = text.slice(text.indexOf('## Agent tools'));
    expect(text).toContain('## Agent tools');
    for (const named of [
      '`.mcp.json`',
      '`x.manifest.json`',
      '`POST /mcp`',
      '`.claude/commands/feature.md`',
      '`.claude/commands/planx.md`',
      '`.claude/commands/verify.md`',
    ]) {
      expect(block).toContain(named);
    }
  });

  test('the files the block names are files x new writes', () => {
    expect(docsFiles(app).some((file) => file.path === '.mcp.json')).toBe(true);
  });
});
