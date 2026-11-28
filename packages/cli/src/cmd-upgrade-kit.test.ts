// `x upgrade` and the agent kit a hop brings: the INSTALLED CLI's `x kit --json` runs after the
// codemods and the guards, before the gate judges the tree, and its refresh is in the report.

import { afterEach, describe, expect, test } from 'bun:test';
import { fixture, kitDocument, recording, removeFixtures, run } from './cmd-upgrade-fixture';

afterEach(removeFixtures);

const WRITTEN = [
  { path: '.claude/skills/feature/SKILL.md', action: 'created' },
  { path: '.claude/agents/web.md', action: 'updated' },
];

describe('unit · x upgrade, the agent kit a hop brings', () => {
  test('the installed x kit runs between the guards and the gate, and its writes are reported', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ kit: kitDocument(WRITTEN) });
    const { code, output, lines } = await run(dir, runner, [], { json: false });
    expect(code).toBe(0);
    expect(spawned.slice(spawned.indexOf('x kit') - 1)).toEqual([
      'x verify --only boundaries',
      'x kit',
      'x exercise',
      'x verify',
    ]);
    expect(Object.keys(output)).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('agent kit: 1 written, 1 refreshed, 0 already current');
    expect(text).toContain('created .claude/skills/feature/SKILL.md');
    expect(text).not.toContain('⟦');
  });

  test('--json carries the refresh under data.kit', async () => {
    const dir = await fixture();
    const { runner } = recording({ kit: kitDocument(WRITTEN) });
    const { output } = await run(dir, runner);
    expect(output.data?.kit).toMatchObject({ reported: true, written: WRITTEN, unchanged: 0 });
  });

  test('an installed CLI with no x kit is reported unknown, and the hop stays green', async () => {
    const dir = await fixture();
    const { runner } = recording({ kit: 'error: unknown command kit\n' });
    const { code, output, lines } = await run(dir, runner, [], { json: false });
    expect(code).toBe(0);
    expect(Object.keys(output)).toEqual([]);
    expect(lines.join('\n')).toContain('the installed CLI has no x kit');
    const json = await run(
      await fixture(),
      recording({ kit: 'error: unknown command kit\n' }).runner,
    );
    expect(json.output.data?.kit).toMatchObject({ reported: false, written: [] });
  });

  test('a finding x kit leaves for the author is listed with its fix', async () => {
    const dir = await fixture();
    const finding = {
      code: 'X_KIT_SHADOWED',
      cause: 'shadowed',
      fix: 'git mv .claude/commands/feature.md .claude/commands/app-feature.md',
      at: '.claude/commands/feature.md',
    };
    const { runner } = recording({ kit: kitDocument([], [finding]) });
    const { lines } = await run(dir, runner, [], { json: false });
    expect(lines.join('\n')).toContain(
      `X_KIT_SHADOWED .claude/commands/feature.md — fix: ${finding.fix}`,
    );
  });
});
