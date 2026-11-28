import { describe, expect, test } from 'bun:test';
import type { KitDisk } from './app-kit';
import { activeKit, judgeKit, parseKitMarker } from './app-kit';
import type { KitFile } from './kit/registry';
import { KIT_MARKER } from './kit/registry';

const MANAGED: readonly KitFile[] = [
  {
    path: '.claude/skills/feature/SKILL.md',
    contents: 'feature v2\n',
    name: 'feature',
    kind: 'skill',
  },
  { path: '.claude/agents/audit.md', contents: 'audit v2\n', name: 'audit', kind: 'agent' },
];

const diskOf = (files: Record<string, string>): KitDisk => ({
  read: async (path) => files[path],
  glob: async () => Object.keys(files),
});

const CLEAN = {
  [KIT_MARKER]: '{"off":[]}',
  '.claude/skills/feature/SKILL.md': 'feature v2\n',
  '.claude/agents/audit.md': 'audit v2\n',
};

describe('unit · app kit verdict', () => {
  test('an app holding every managed file as rendered is clean', async () => {
    const verdict = await judgeKit(diskOf(CLEAN), MANAGED);
    expect(verdict.findings).toEqual([]);
    expect(verdict.warnings).toEqual([]);
  });

  test('a missing managed file is X_KIT_DRIFT, fixed by bunx x kit', async () => {
    const { '.claude/agents/audit.md': _gone, ...held } = CLEAN;
    const verdict = await judgeKit(diskOf(held), MANAGED);
    expect(verdict.findings.map((f) => [f.code, f.at, f.fix])).toEqual([
      ['X_KIT_DRIFT', '.claude/agents/audit.md', 'bunx x kit'],
    ]);
  });

  test('an edited managed file is X_KIT_DRIFT and the fix names the app- variant', async () => {
    const verdict = await judgeKit(
      diskOf({ ...CLEAN, '.claude/skills/feature/SKILL.md': 'my feature\n' }),
      MANAGED,
    );
    const [one] = verdict.findings;
    expect(verdict.findings).toHaveLength(1);
    expect(one?.code).toBe('X_KIT_DRIFT');
    expect(one?.fix.startsWith('bunx x kit')).toBe(true);
    expect(one?.fix).toContain('.claude/skills/app-feature/SKILL.md');
  });

  test('CRLF alone is not an edit', async () => {
    const verdict = await judgeKit(
      diskOf({ ...CLEAN, '.claude/agents/audit.md': 'audit v2\r\n' }),
      MANAGED,
    );
    expect(verdict.findings).toEqual([]);
  });

  test('a command a managed skill shadows is X_KIT_SHADOWED, fixed by renaming it', async () => {
    const verdict = await judgeKit(
      diskOf({ ...CLEAN, '.claude/commands/feature.md': 'old\n' }),
      MANAGED,
    );
    expect(verdict.findings.map((f) => [f.code, f.at, f.fix])).toEqual([
      [
        'X_KIT_SHADOWED',
        '.claude/commands/feature.md',
        'git mv .claude/commands/feature.md .claude/commands/app-feature.md',
      ],
    ]);
  });

  test('no marker: one warning, no findings, whatever the disk holds', async () => {
    const verdict = await judgeKit(diskOf({ '.claude/agents/audit.md': 'edited' }), MANAGED);
    expect(verdict.findings).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain('fix: bunx x kit');
  });

  test('off switches an entry off: neither missing nor edited is a finding', async () => {
    const verdict = await judgeKit(
      diskOf({ [KIT_MARKER]: '{"off":["feature","audit"]}', '.claude/agents/audit.md': 'mine' }),
      MANAGED,
    );
    expect(verdict.findings).toEqual([]);
  });

  test('a command beside a skill that is off is not shadowed', async () => {
    const verdict = await judgeKit(
      diskOf({
        [KIT_MARKER]: '{"off":["feature"]}',
        '.claude/commands/feature.md': 'mine\n',
        '.claude/agents/audit.md': 'audit v2\n',
      }),
      MANAGED,
    );
    expect(verdict.findings).toEqual([]);
  });

  test('an unreadable marker is its own finding and judges nothing else', async () => {
    const verdict = await judgeKit(diskOf({ [KIT_MARKER]: '{"off": "feature"}' }), MANAGED);
    expect(verdict.findings.map((f) => [f.code, f.at])).toEqual([['X_KIT_DRIFT', KIT_MARKER]]);
  });

  test('the marker parser and activeKit', () => {
    expect(parseKitMarker(undefined).state).toBe('absent');
    expect(parseKitMarker('nope').state).toBe('invalid');
    expect(parseKitMarker('{}')).toEqual({ state: 'present', off: [] });
    expect(activeKit(MANAGED, ['audit']).map((f) => f.name)).toEqual(['feature']);
  });
});
