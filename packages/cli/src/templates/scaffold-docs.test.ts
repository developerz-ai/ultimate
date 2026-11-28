// The brain a generated app is born with, held to one thing: it must name the gate the app
// actually has. It named `bun run check` (a build, then `x verify`) until `x verify` learned to
// build what its `budgets` step weighs and the `check` script was deleted (plan 101, 21). A brain
// that names a script the app no longer has is worse than one that names none: it is confidently
// wrong, and the agent's first command fails.

import { describe, expect, test } from 'bun:test';
import { kitFiles } from '../kit/registry';
import { names } from './naming';
import { DESIGN_PATH } from './scaffold-design';
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
    for (const file of kitFiles(app)) expect(String(file.contents)).not.toContain('bun run check');
  });

  test('one file under two names: AGENTS.md is a link to CLAUDE.md, carrying the same text', () => {
    const agents = docsFiles(app).find((file) => file.path === 'AGENTS.md');
    if (agents === undefined) return expect.unreachable('x new writes no AGENTS.md');
    expect(agents.merge === undefined ? agents.link : undefined).toBe('CLAUDE.md');
    expect(doc('AGENTS.md')).toBe(doc('CLAUDE.md'));
    // The target is planned first, so `writeNewApp` never links to a file not yet on disk.
    const order = docsFiles(app).map((file) => file.path);
    expect(order.indexOf('CLAUDE.md')).toBeLessThan(order.indexOf('AGENTS.md'));
  });

  test('the gate row names the CI that runs the same gate, in parts it plans and merges', () => {
    const row = doc('CLAUDE.md')
      .split('\n')
      .find((line) => line.startsWith('| One gate |'));
    expect(row).toContain('bun run setup && bun run verify --only');
    expect(row).toContain('bun run verify plan --json');
    expect(row).toContain('bun run verify merge');
    expect(doc('CLAUDE.md')).toContain('.github/workflows/ci.yml');
  });

  test('the verify skill runs bun run verify — the command whose whole job is the gate', () => {
    const verify = emitted(kitFiles(app), '.claude/skills/verify/SKILL.md');
    const fence = verify.indexOf('```sh\n');
    expect(verify.slice(fence + 6).split('\n')[0]).toBe('bun run verify --json');
  });

  test('the feature skill gates on bun run verify and finishes at merged', () => {
    const feature = emitted(kitFiles(app), '.claude/skills/feature/SKILL.md');
    expect(feature).toContain('**Done means merged.**');
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
      '`.claude/skills/`',
      '`bunx x kit`',
    ]) {
      expect(block).toContain(named);
    }
  });

  test('the files the block names are files x new writes', () => {
    expect(docsFiles(app).some((file) => file.path === '.mcp.json')).toBe(true);
    expect(docsFiles(app).some((file) => file.path.startsWith('.claude/skills/'))).toBe(true);
    expect(docsFiles(app).some((file) => file.path.startsWith('.claude/commands/'))).toBe(false);
  });
});

describe('unit · motion, effects and visual quality each name what refuses them', () => {
  const row = (label: string): string =>
    doc('AGENTS.md')
      .split('\n')
      .find((line) => line.startsWith(`| ${label} |`)) ?? '';

  test.each([
    ['Timing', '`raw-motion`, `raw-motion-script`'],
    ['Motion adapter', '`motion-adapter`'],
    ['Frame loops', '`raw-frame-loop`'],
    ['Effects', '`effect-without-fallback`'],
    ['Motion', '`animated-layout-property`, `animated-layout-script`'],
  ])('the %s row names the adapter and ends in %s', (label, refuser) => {
    expect(row(label)).toContain('@ultimat3/');
    expect(row(label).trimEnd().endsWith(`${refuser} |`)).toBe(true);
  });

  test('the Visual quality section is a table whose every rule names its refuser', () => {
    const text = doc('AGENTS.md');
    const start = text.indexOf('## Visual quality');
    expect(start).toBeGreaterThan(-1);
    const rows = text
      .slice(start, text.indexOf('\n## ', start + 1))
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Rule |'));
    expect(rows.length).toBeGreaterThan(2);
    for (const line of rows) {
      const refuser = line.split(' | ').at(-1)?.replace(/ \|$/, '').trim() ?? '';
      expect({ line, refuser: refuser.length > 0 }).toEqual({ line, refuser: true });
    }
    expect(text.slice(start)).toContain(DESIGN_PATH);
  });

  test('x new writes the DESIGN.md the web agent is told to read first', () => {
    const design = doc(DESIGN_PATH);
    expect(design.startsWith('---\ntokens:') || design.startsWith('---\n#')).toBe(true);
    expect(emitted(kitFiles(app), '.claude/agents/web.md')).toContain(DESIGN_PATH);
  });
});
