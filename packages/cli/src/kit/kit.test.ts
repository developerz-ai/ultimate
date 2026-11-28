// The kit's one list, held to its fixed names: `x kit`, the gate and `x upgrade` compile against
// `KIT_MARKER`, `MANAGED_KIT_PATHS` and `kitFiles(app)`, so a renamed entry is a break three
// commands find late. And each managed file says it is managed, where an editor will see it.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import { claudeFiles } from '../templates/scaffold-claude';
import { DESIGN_PATH } from '../templates/scaffold-design';
import { appVariantPath } from './managed';
import { KIT_ENTRIES, KIT_MARKER, kitFiles, kitMarkerFile, MANAGED_KIT_PATHS } from './registry';

const app = names('ledger-demo');

describe('unit · the kit registry', () => {
  test('five skills and five agents, by their fixed names', () => {
    const of = (kind: string) =>
      KIT_ENTRIES.filter((entry) => entry.kind === kind).map((entry) => entry.name);
    expect(of('skill')).toEqual(['feature', 'planx', 'verify', 'upgrade', 'design-research']);
    expect(of('agent')).toEqual(['shape', 'data', 'server', 'web', 'audit']);
  });

  test('names are disjoint across kinds, so "off" can name an entry alone', () => {
    const all = KIT_ENTRIES.map((entry) => entry.name);
    expect(new Set(all).size).toBe(all.length);
  });

  test('kitFiles renders exactly MANAGED_KIT_PATHS, in order, as text', () => {
    const files = kitFiles(app);
    expect(files.map((file) => file.path)).toEqual([...MANAGED_KIT_PATHS]);
    for (const file of files) expect(typeof file.contents).toBe('string');
  });

  test('a skill is a SKILL.md in its own directory; an agent is one file', () => {
    for (const entry of KIT_ENTRIES)
      expect(entry.path).toBe(
        entry.kind === 'skill'
          ? `.claude/skills/${entry.name}/SKILL.md`
          : `.claude/agents/${entry.name}.md`,
      );
  });

  test('neither the marker nor DESIGN.md is managed — both are the app’s', () => {
    expect(KIT_MARKER).toBe('.claude/kit.json');
    expect(MANAGED_KIT_PATHS).not.toContain(KIT_MARKER);
    expect(MANAGED_KIT_PATHS).not.toContain(DESIGN_PATH);
  });

  test('no managed path is an app-* path, so an app variant can never be overwritten', () => {
    for (const path of MANAGED_KIT_PATHS) expect(path).not.toMatch(/\/app-/);
    expect(appVariantPath('skill', 'feature')).toBe('.claude/skills/app-feature/SKILL.md');
    expect(appVariantPath('agent', 'web')).toBe('.claude/agents/app-web.md');
  });

  test('the marker opts in with nothing switched off', () => {
    const marker = kitMarkerFile();
    expect(marker.path).toBe(KIT_MARKER);
    expect(JSON.parse(String(marker.contents))).toEqual({ off: [] });
  });

  test('rendering is a pure function of the app: the gate can diff it byte for byte', () => {
    expect(kitFiles(names('ledger-demo'))).toEqual(kitFiles(names('ledger-demo')));
    const other = kitFiles(names('shop'));
    expect(other.find((file) => file.name === 'web')?.contents).toContain('mcp__shop__*');
  });
});

describe('unit · each managed file says so, and how to own a variant', () => {
  for (const file of kitFiles(app)) {
    test(`${file.path} names x kit, X_KIT_DRIFT and its app-* path`, () => {
      expect(file.contents).toContain('`bunx x kit`');
      expect(file.contents).toContain('X_KIT_DRIFT');
      expect(file.contents).toContain(appVariantPath(file.kind, file.name));
    });
  }
});

describe('unit · x new writes the kit, the marker and the design stub', () => {
  test('claudeFiles holds every managed file and the marker, and no commands/', () => {
    const paths = claudeFiles(app).map((file) => file.path);
    for (const path of [...MANAGED_KIT_PATHS, KIT_MARKER]) expect(paths).toContain(path);
    expect(paths.filter((path) => path.startsWith('.claude/commands/'))).toEqual([]);
  });
});

describe('unit · the briefs say what the plan asks of them', () => {
  const body = (name: string): string =>
    kitFiles(app).find((file) => file.name === name)?.contents ?? '';

  test('feature: one checkout, path-disjoint slices, one gate, one PR, done when merged', () => {
    const text = body('feature');
    for (const phrase of [
      '**Done means merged.**',
      '**One checkout.**',
      'path-disjoint',
      'Gate once',
      'One PR',
      'graph.query',
      'tests.run',
      'verify.narrow',
      'design-research',
    ])
      expect(text).toContain(phrase);
  });

  test('planx: a directory with overview.md, slice files and status.yml', () => {
    const text = body('planx');
    for (const phrase of [
      'overview.md',
      '01-<slice>.md',
      'status.yml',
      'docs/plans/<YYYY-MM-DD>-<slug>/',
    ])
      expect(text).toContain(phrase);
  });

  test('verify: every fix line is checked for source, scope and effect first', () => {
    const text = body('verify');
    for (const phrase of ['**Source**', '**Scope**', '**Effect**', 'bunx x errors explain'])
      expect(text).toContain(phrase);
  });

  test('upgrade: dry run, the report, the kit, the gate — in that order', () => {
    const text = body('upgrade');
    const at = (phrase: string) => text.indexOf(phrase);
    expect(at('bunx x upgrade --dry-run --json')).toBeGreaterThan(-1);
    expect(at('bunx x upgrade --dry-run --json')).toBeLessThan(at('left for you'));
    expect(at('left for you')).toBeLessThan(at('bunx x kit --json'));
    expect(at('bunx x kit --json')).toBeLessThan(at('bun run verify --json'));
  });

  test('design-research: licence posture before measuring, compare after building', () => {
    // After the front matter: the description names the same steps in one sentence.
    const text = body('design-research').split('\n---\n').slice(1).join('\n---\n');
    const at = (phrase: string) => text.indexOf(phrase);
    expect(at('ideas-only')).toBeGreaterThan(-1);
    expect(at('ideas-only')).toBeLessThan(at('bunx x design research <url…>'));
    expect(at('bunx x design research <url…>')).toBeLessThan(at('`web` agent'));
    expect(at('`web` agent')).toBeLessThan(at('--against'));
    expect(text).toContain(DESIGN_PATH);
  });

  test('web reads DESIGN.md before its rules table', () => {
    const text = body('web');
    expect(text.indexOf(DESIGN_PATH)).toBeGreaterThan(-1);
    expect(text.indexOf(DESIGN_PATH)).toBeLessThan(text.indexOf('| Rule |'));
  });

  test('audit asks for file:line and the failing scenario, via db.explain and requests.statements', () => {
    const text = body('audit');
    for (const phrase of ['<file>:<line>', 'Scenario:', 'db.explain', 'requests.statements'])
      expect(text).toContain(phrase);
  });
});
