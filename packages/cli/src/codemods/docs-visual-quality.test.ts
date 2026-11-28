import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { codemod } from './docs-visual-quality';

const OLD = `# app

| Timing | a duration and an easing curve come off the motion scale, never a literal | \`raw-motion\` |
| Motion | animate \`transform\` and \`opacity\` — never a layout property, never \`transition: all\` | \`animated-layout-property\` |

- \`.claude/\` holds a harness that reads this file: \`/feature\`, \`/planx\`, \`/verify\` and four
  boundary-scoped subagents. \`.claude/README.md\` says what each costs; every file is deletable.

## Agent tools

| \`.claude/commands/feature.md\` | build or fix one thing end to end, done when \`bun run verify\` is green | plain markdown any agent can follow |
| \`.claude/commands/planx.md\` | write a plan to \`docs/plans/\` | the same |
| \`.claude/commands/verify.md\` | run the gate and fix what it reports | the same |
`;

describe('unit · docs-visual-quality codemod', () => {
  test('carries every addition into an old brief', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': OLD });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    const text = app.files['CLAUDE.md'] ?? '';
    for (const part of [
      'raw-motion-script',
      '| Motion adapter |',
      '| Frame loops |',
      '| Effects |',
      'animated-layout-script',
      '## Visual quality\n',
      'holds the agent kit',
      '`.claude/skills/`',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('.claude/commands/');
    expect(text).toContain('## Visual quality');
    expect(text).toContain('## Agent tools');
    expect(text.indexOf('## Visual quality')).toBeLessThan(text.indexOf('## Agent tools'));
  });

  const ROWS_3122 = [
    '| `.claude/commands/feature.md` | build or fix one thing end to end, done when `bun run verify` is green | plain markdown: any agent can read one and follow it |',
    '| `.claude/commands/planx.md` | write a plan to `docs/plans/` for another agent to execute | the same |',
    '| `.claude/commands/verify.md` | run the gate and fix what it reports | the same |',
  ].join('\n');
  const OLD_ROWS = OLD.slice(OLD.indexOf('| `.claude/commands/feature.md`'));

  test('the commands rows as 31.22 shipped them are swapped too', async () => {
    const reworded = OLD.replace(OLD_ROWS, `${ROWS_3122}\n`);
    expect(reworded).not.toBe(OLD);
    const app = memoryCodemodApp({ 'CLAUDE.md': reworded });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    expect(app.files['CLAUDE.md']).toContain('`.claude/skills/`');
    expect(app.files['CLAUDE.md']).not.toContain('.claude/commands/');
  });

  test('a row the author customised is reported, never replaced', async () => {
    const custom = OLD.replace(
      'done when `bun run verify` is green | plain markdown any agent can follow |',
      'done when `bun run verify` is green AND a second review approves | plain markdown any agent can follow |',
    );
    const app = memoryCodemodApp({ 'CLAUDE.md': custom });
    const result = await codemod.run(app);
    expect(app.files['CLAUDE.md']).toContain('a second review approves');
    expect(app.files['CLAUDE.md']).toContain('`.claude/commands/planx.md`');
    expect(
      result.skipped.some(
        (skip) => skip.reason.includes('you changed') && skip.reason.includes('.claude/skills/'),
      ),
    ).toBe(true);
  });

  test('only the Agent tools table migrates: an earlier table keeps its command row', async () => {
    const earlier = `# app\n\n## Notes\n\n| Tool | Use |\n|---|---|\n${ROWS_3122.split('\n')[1]}\n\n${OLD.slice(OLD.indexOf('| Timing'))}`;
    const app = memoryCodemodApp({ 'CLAUDE.md': earlier });
    await codemod.run(app);
    const after = app.files['CLAUDE.md'] ?? '';
    const [notes = '', tools = ''] = after.split('## Agent tools');
    expect(notes).toContain('`.claude/commands/planx.md`');
    expect(tools).toContain('`.claude/skills/`');
    expect(tools).not.toContain('.claude/commands/');
  });

  test('a second run changes nothing', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': OLD });
    await codemod.run(app);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a brief over its budget is reported with the row to add, not rewritten', async () => {
    const app = memoryCodemodApp({
      'CLAUDE.md': OLD,
      'x.verify.json': '{"agentsMdMaxBytes": 100}\n',
    });
    const result = await codemod.run(app);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]?.reason).toContain('budget');
  });

  test('a reworded brief is reported, never guessed at', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': '# mine\n' });
    const result = await codemod.run(app);
    expect(app.files['CLAUDE.md']).toBe('# mine\n');
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
