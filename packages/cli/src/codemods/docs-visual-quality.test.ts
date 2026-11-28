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
    expect(text.indexOf('## Visual quality')).toBeLessThan(text.indexOf('## Agent tools'));
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
